import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import * as lsp from 'vscode-languageclient/node';
import {
	NOS, NOSId, TrackedDocument,
	VersionDetectedParams, ModelsNotFoundParams,
} from './nos';
import { sros } from './sros';
import { srlinux } from './srlinux';
import * as utils from './utils';

let statusBar: vscode.StatusBarItem;
const SRPLS_VERSION = 'v0.1.1';
const SRPLS_RELEASE_BASE_URL = `https://github.com/srl-labs/srpls/releases/download/${SRPLS_VERSION}`;

const PLATFORMS: Record<string, string> = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const ARCHS: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
const SRLINUX_KNOWN_PLATFORMS = [
	'7215-IXS-A1',
	'7220-IXR-D1',
	'7220-IXR-D2L',
	'7220-IXR-D3L',
	'7220-IXR-D4',
	'7220-IXR-D5',
	'7220-IXR-H2',
	'7220-IXR-H3',
	'7220-IXR-H4',
	'7220-IXR-H4-32D',
	'7220-IXR-H5-32D',
	'7220-IXR-H5-64D',
	'7220-IXR-H5-64O',
	'7250-IXR-10e',
	'7250-IXR-18e',
	'7250-IXR-6e',
	'7250-IXR-X1b',
	'7250-IXR-X3b',
	'7730-SXR-1d-32d',
	'7730-SXR-1x-44s',
];
const VERSION_DIRECTIVE_RE = /^\s*(?:#|\/\/|!)?\s*version\s*=\s*\d+\.\d+\s*$/i;
const PLATFORM_DIRECTIVE_RE = /^\s*(?:#|\/\/|!)\s*platform\s*=\s*\S+\s*$/i;
const PLATFORM_DIRECTIVE_CAPTURE_RE = /^\s*(?:#|\/\/|!)\s*platform\s*=\s*(\S+)\s*$/i;
const SROS_FORMAT_VERSION_RE = /Configuration format version \d+\.\d+/i;
const CUSTOM_PLATFORM_PICK = 'Custom...';

const nosMap: Record<NOSId, NOS> = {
	sros,
	srlinux,
};

const clients = new Map<NOSId, lsp.LanguageClient>();
const documents = new Map<string, TrackedDocument>();

export async function activate(context: vscode.ExtensionContext) {
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'srSyntax.selectStatusField';
	context.subscriptions.push(statusBar);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar())
	);
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((event) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) {
				return;
			}

			if (!(editor.document.languageId in nosMap)) {
				return;
			}

			const shouldTriggerSuggest = event.contentChanges.some(shouldTriggerSuggestForChange);
			if (!shouldTriggerSuggest) {
				return;
			}

			setTimeout(() => {
				void vscode.commands.executeCommand('editor.action.triggerSuggest');
			}, 0);
		})
	);

	let cmd: string;
	try {
		cmd = await getOrDownloadSrpls(context.extensionPath);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`Failed to prepare srpls ${SRPLS_VERSION}: ${msg}`);
		return;
	}

	const startPromises = (Object.entries(nosMap) as [NOSId, NOS][]).map(([id, nos]) => {
		fs.mkdirSync(nos.yangDir, { recursive: true });

		const serverOptions: lsp.ServerOptions = {
			run: { command: cmd, args: ['--nos', id] },
			debug: { command: cmd, args: ['--nos', id] },
		};

		const clientOptions: lsp.LanguageClientOptions = {
			documentSelector: [{ scheme: 'file', language: id }],
			synchronize: {
				fileEvents: vscode.workspace.createFileSystemWatcher(`**/*${nos.cfgSuffix}`)
			},
		};

		const client = new lsp.LanguageClient(
			`srpls-${id}`,
			`srpls (${nos.label})`,
			serverOptions,
			clientOptions
		);

		registerNotifications(client, nos);
		clients.set(id, client);
		return client.start();
	});
	await Promise.all(startPromises);

	context.subscriptions.push(
		vscode.commands.registerCommand('srSyntax.restartServer', async () => {
			documents.clear();
			await Promise.all(Array.from(clients.values(), (client) => client.restart()));
			vscode.window.setStatusBarMessage('LSP servers restarted', 2000);
			updateStatusBar();
		}),
		vscode.commands.registerCommand('srSyntax.toggleFormat', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}
			await convertDocument(editor);
		}),
		vscode.commands.registerCommand('srSyntax.selectStatusField', async () => {
			await selectStatusFieldForActiveDocument();
		}),
		vscode.commands.registerCommand('srSyntax.selectVersion', async () => {
			await selectVersionForActiveDocument();
		}),
		vscode.commands.registerCommand('srSyntax.selectPlatform', async () => {
			await selectPlatformForActiveDocument();
		}),
	);
}

function registerNotifications(client: lsp.LanguageClient, nos: NOS) {
	client.onNotification('srpls/versionDetected', (params: VersionDetectedParams) => {
		const existing = documents.get(params.uri);
		const fallbackPlatform = extractPlatformFromOpenDocument(params.uri);
		const platform = params.platform || fallbackPlatform || existing?.platform || '';
		documents.set(params.uri, { nos, version: params.version, platform });
		updateStatusBar();
	});

	client.onNotification('srpls/modelsNotFound', async (params: ModelsNotFoundParams) => {
		let version = params.version;
		if (!nos.isKnownVersion(version)) {
			version = nos.latestVersion();
		}

		if (!await nos.downloadYangModels(version)) {
			return;
		}

		await client.restart();
	});
}

function updateStatusBar() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		statusBar.hide();
		return;
	}

	const doc = documents.get(editor.document.uri.toString());
	if (!doc) {
		statusBar.hide();
		return;
	}

	const platform = doc.platform || 'unset';
	statusBar.text = `${doc.nos.label} $(versions) ${doc.version} $(device-desktop) ${platform}`;
	statusBar.tooltip = `${doc.nos.label} model version ${doc.version}\nPlatform ${platform}\nClick to select version or platform`;
	statusBar.show();
}

async function selectStatusFieldForActiveDocument() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const uri = editor.document.uri.toString();
	const tracked = documents.get(uri);
	if (!tracked) {
		vscode.window.showInformationMessage('Version/platform is not detected yet for this document.');
		return;
	}

	const platform = tracked.platform || 'unset';
	const picked = await vscode.window.showQuickPick(
		[
			{ label: 'Version', description: tracked.version, detail: 'Select model version' },
			{ label: 'Platform', description: platform, detail: 'Select platform' },
		],
		{
			title: `${tracked.nos.label}: Select field`,
			placeHolder: 'Choose what to change',
		}
	);
	if (!picked) {
		return;
	}

	if (picked.label === 'Version') {
		await selectVersionForActiveDocument();
		return;
	}

	await selectPlatformForActiveDocument();
}

async function selectVersionForActiveDocument() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const uri = editor.document.uri.toString();
	const tracked = documents.get(uri);
	if (!tracked) {
		vscode.window.showInformationMessage('Version is not detected yet for this document.');
		return;
	}

	const versions = sortVersionsDescending(tracked.nos.knownVersions());
	if (versions.length === 0) {
		vscode.window.showWarningMessage(`No known ${tracked.nos.label} versions are available.`);
		return;
	}

	const picked = await vscode.window.showQuickPick(
		versions.map((version) => ({
			label: version,
			description: version === tracked.version ? 'current' : '',
		})),
		{
			title: `${tracked.nos.label}: Select model version`,
			placeHolder: 'Choose the model version for this document',
		}
	);
	if (!picked || picked.label === tracked.version) {
		return;
	}

	const applied = await applyVersionSelection(editor, tracked.nos.name, picked.label);
	if (!applied) {
		vscode.window.showWarningMessage('Could not update the document version directive.');
		return;
	}

	documents.set(uri, { ...tracked, version: picked.label });
	updateStatusBar();
}

async function selectPlatformForActiveDocument() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const uri = editor.document.uri.toString();
	const tracked = documents.get(uri);
	if (!tracked) {
		vscode.window.showInformationMessage('Platform is not detected yet for this document.');
		return;
	}

	const currentPlatform = tracked.platform || '';
	let platform = '';

	if (tracked.nos.name === 'srlinux') {
		const options = Array.from(new Set([currentPlatform, ...SRLINUX_KNOWN_PLATFORMS].filter(Boolean)));
		const pickItems: vscode.QuickPickItem[] = options.map((option) => ({
			label: option,
			description: option === currentPlatform ? 'current' : '',
		}));
		pickItems.push({ label: CUSTOM_PLATFORM_PICK, description: 'Enter a custom platform value' });

		const picked = await vscode.window.showQuickPick(pickItems, {
			title: 'SR Linux: Select platform',
			placeHolder: 'Choose the platform used for interface validation',
		});
		if (!picked) {
			return;
		}

		platform = picked.label;
		if (platform === CUSTOM_PLATFORM_PICK) {
			const custom = await vscode.window.showInputBox({
				title: 'SR Linux: Custom platform',
				prompt: 'Enter a platform name (for example 7220-IXR-D2L)',
				value: currentPlatform,
				ignoreFocusOut: true,
				validateInput: (value) => value.trim() ? null : 'Platform must not be empty',
			});
			if (!custom) {
				return;
			}
			platform = custom.trim();
		}
	} else {
		const custom = await vscode.window.showInputBox({
			title: `${tracked.nos.label}: Set platform`,
			prompt: 'Enter a platform name',
			value: currentPlatform,
			ignoreFocusOut: true,
			validateInput: (value) => value.trim() ? null : 'Platform must not be empty',
		});
		if (!custom) {
			return;
		}
		platform = custom.trim();
	}

	if (platform === currentPlatform) {
		return;
	}

	const applied = await applyPlatformSelection(editor, platform);
	if (!applied) {
		vscode.window.showWarningMessage('Could not update the document platform directive.');
		return;
	}

	documents.set(uri, { ...tracked, platform });
	updateStatusBar();
}

function extractPlatformFromOpenDocument(uri: string): string {
	const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri);
	if (!openDoc) {
		return '';
	}
	return extractPlatformDirective(openDoc.getText());
}

function extractPlatformDirective(content: string): string {
	const lines = content.split(/\r?\n/, 6);
	const scanLimit = Math.min(5, lines.length);
	for (let i = 0; i < scanLimit; i++) {
		const match = PLATFORM_DIRECTIVE_CAPTURE_RE.exec(lines[i]);
		if (match) {
			return match[1];
		}
	}
	return '';
}

function sortVersionsDescending(versions: string[]): string[] {
	const sorted: string[] = [];
	for (const version of versions) {
		let inserted = false;
		for (let i = 0; i < sorted.length; i++) {
			if (compareVersionParts(version, sorted[i]) > 0) {
				sorted.splice(i, 0, version);
				inserted = true;
				break;
			}
		}
		if (!inserted) {
			sorted.push(version);
		}
	}
	return sorted;
}

function compareVersionParts(a: string, b: string): number {
	const aParts = a.split('.').map(Number);
	const bParts = b.split('.').map(Number);
	const max = Math.max(aParts.length, bParts.length);
	for (let i = 0; i < max; i++) {
		const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

async function applyVersionSelection(editor: vscode.TextEditor, nos: NOSId, version: string): Promise<boolean> {
	const doc = editor.document;
	const content = doc.getText();
	const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const nextContent = nos === 'srlinux'
		? withSRLinuxVersionDirective(content, version, eol)
		: withSROSVersionDirective(content, version, eol);
	return replaceWholeDocument(editor, content, nextContent);
}

async function applyPlatformSelection(editor: vscode.TextEditor, platform: string): Promise<boolean> {
	const doc = editor.document;
	const content = doc.getText();
	const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const nextContent = withPlatformDirective(content, platform, eol);
	return replaceWholeDocument(editor, content, nextContent);
}

function withSRLinuxVersionDirective(content: string, version: string, eol: string): string {
	const lines = content === '' ? [] : content.split(/\r?\n/);
	const directive = `# version=${version}`;
	const scanLimit = Math.min(5, lines.length);
	let existingIdx = -1;
	for (let i = 0; i < scanLimit; i++) {
		if (VERSION_DIRECTIVE_RE.test(lines[i])) {
			existingIdx = i;
			break;
		}
	}

	if (existingIdx === 0) {
		lines[0] = directive;
	} else {
		if (existingIdx > 0) {
			lines.splice(existingIdx, 1);
		}
		lines.unshift(directive);
	}

	return lines.join(eol);
}

function withSROSVersionDirective(content: string, version: string, eol: string): string {
	const lines = content === '' ? [] : content.split(/\r?\n/);
	const directive = `# Configuration format version ${version}`;
	const scanLimit = Math.min(10, lines.length);
	for (let i = 0; i < scanLimit; i++) {
		if (SROS_FORMAT_VERSION_RE.test(lines[i])) {
			lines[i] = directive;
			return lines.join(eol);
		}
	}

	lines.unshift(directive);
	return lines.join(eol);
}

function withPlatformDirective(content: string, platform: string, eol: string): string {
	const lines = content === '' ? [] : content.split(/\r?\n/);
	const directive = `# platform=${platform}`;
	const scanLimit = Math.min(5, lines.length);
	for (let i = 0; i < scanLimit; i++) {
		if (PLATFORM_DIRECTIVE_RE.test(lines[i])) {
			lines[i] = directive;
			return lines.join(eol);
		}
	}

	if (lines.length === 0) {
		lines.push(directive);
		return lines.join(eol);
	}

	lines.splice(1, 0, directive);
	return lines.join(eol);
}

function replaceWholeDocument(editor: vscode.TextEditor, currentContent: string, nextContent: string): Thenable<boolean> {
	if (currentContent === nextContent) {
		return Promise.resolve(true);
	}

	const fullRange = new vscode.Range(
		editor.document.positionAt(0),
		editor.document.positionAt(currentContent.length),
	);
	return editor.edit((editBuilder) => {
		editBuilder.replace(fullRange, nextContent);
	});
}

/** Find the LSP client for the given document's language. */
function getClientForDocument(doc: vscode.TextDocument): lsp.LanguageClient | undefined {
	for (const [id, client] of clients) {
		if (doc.languageId === id) {
			return client;
		}
	}
	return undefined;
}

/** Convert document between flat and brace format via the LSP server. */
async function convertDocument(editor: vscode.TextEditor) {
	const doc = editor.document;
	const content = doc.getText();
	const uri = doc.uri.toString();
	const client = getClientForDocument(doc);

	if (!client) {
		vscode.window.showWarningMessage('No language server available for this document');
		return;
	}

	let newContent: string;
	try {
		const result = await client.sendRequest('workspace/executeCommand', {
			command: 'srpls.convert',
			arguments: [uri, content],
		});
		if (typeof result !== 'string') {
			vscode.window.showWarningMessage('Conversion failed: unexpected server response');
			return;
		}
		newContent = result;
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showWarningMessage(`Conversion failed: ${msg}`);
		return;
	}

	const fullRange = new vscode.Range(
		doc.positionAt(0),
		doc.positionAt(content.length),
	);

	await editor.edit(editBuilder => {
		editBuilder.replace(fullRange, newContent);
	});
}

export async function deactivate(): Promise<void> {
	await Promise.all(Array.from(clients.values(), (client) => client.stop()));
}

async function getOrDownloadSrpls(extensionPath: string): Promise<string> {
	const ext = process.platform === 'win32' ? '.exe' : '';

	const localBin = path.join(extensionPath, 'bin', `srpls${ext}`);
	if (fs.existsSync(localBin)) {
		return localBin;
	}

	const plat = PLATFORMS[process.platform];
	const arch = ARCHS[process.arch];
	if (!plat || !arch) {
		throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
	}

	const srplsDir = path.join(os.homedir(), '.srpls');
	const binPath = path.join(srplsDir, `srpls-${SRPLS_VERSION}-${plat}-${arch}${ext}`);

	if (!fs.existsSync(binPath)) {
		await installSrpls(binPath, `srpls-${plat}-${arch}${ext}`);
	}

	return binPath;
}

async function installSrpls(binPath: string, asset: string): Promise<void> {
	const dir = path.dirname(binPath);
	fs.mkdirSync(dir, { recursive: true });

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Downloading srpls ${SRPLS_VERSION}…` },
		async () => {
			const tmpPath = `${binPath}.tmp-${process.pid}`;
			await utils.downloadFile(`${SRPLS_RELEASE_BASE_URL}/${asset}`, tmpPath);
			if (process.platform !== 'win32') {
				await fs.promises.chmod(tmpPath, 0o755);
			}
			await fs.promises.rename(tmpPath, binPath);
		}
	);
}

function shouldTriggerSuggestForChange(change: vscode.TextDocumentContentChangeEvent): boolean {
	if (!change.text) {
		return false;
	}

	if (change.text.includes('\r')) {
		return false;
	}

	if (change.text.endsWith(' ')) {
		return true;
	}

	// Enter in an indented block typically inserts a single newline plus spaces/tabs.
	// Trigger suggestions for that case but avoid noisy triggers for multi-line paste.
	if (change.text.includes('\n')) {
		if (change.rangeLength !== 0) {
			return false;
		}

		const newlineCount = change.text.split('\n').length - 1;
		if (newlineCount !== 1) {
			return false;
		}

		const nonWhitespace = change.text.replace(/\n/g, '').replace(/[ \t]/g, '');
		return nonWhitespace.length === 0;
	}

	return false;
}
