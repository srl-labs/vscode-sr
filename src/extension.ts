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
import * as semver from 'semver';
import * as utils from './utils';

const SRPLS_VERSION = 'v0.1.3';
const SRPLS_RELEASE_BASE_URL = `https://github.com/srl-labs/srpls/releases/download/${SRPLS_VERSION}`;

let versionStatusBar: vscode.StatusBarItem;
let platformStatusBar: vscode.StatusBarItem;

const PLATFORMS: Record<string, string> = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const ARCHS: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };

const nosMap: Record<NOSId, NOS> = {
	sros,
	srlinux,
};

const clients = new Map<NOSId, lsp.LanguageClient>();
const documents = new Map<string, TrackedDocument>();

export async function activate(context: vscode.ExtensionContext) {
	versionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 501);
	versionStatusBar.command = 'srSyntax.selectVersion';
	platformStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 500);
	platformStatusBar.command = 'srSyntax.selectPlatform';
	context.subscriptions.push(versionStatusBar, platformStatusBar);

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

	// Fetch known platforms from each server
	for (const [id, nos] of Object.entries(nosMap) as [NOSId, NOS][]) {
		const client = clients.get(id);
		if (!client) {
			continue;
		}
		try {
			const result = await client.sendRequest('workspace/executeCommand', {
				command: 'srpls.knownPlatforms',
				arguments: [],
			});
			if (Array.isArray(result)) {
				nos.platforms = result as string[];
			}
		} catch {
			// Server may not support knownPlatforms (e.g. SR OS) — leave empty
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('srSyntax.newConfig', async () => {
			await createNewSRConfig();
		}),
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
		const platform = params.platform || '';
		documents.set(params.uri, { nos, version: params.version, platform, modelsLoaded: params.modelsLoaded });
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
		versionStatusBar.hide();
		platformStatusBar.hide();
		return;
	}

	const doc = documents.get(editor.document.uri.toString());
	if (!doc) {
		versionStatusBar.hide();
		platformStatusBar.hide();
		return;
	}

	const dot = doc.modelsLoaded ? '$(pass-filled)' : '$(circle-large-outline)';
	versionStatusBar.text = `$(tag) ${doc.nos.label} ${doc.version} ${dot}`;
	versionStatusBar.tooltip = doc.modelsLoaded
		? `${doc.version} YANG models loaded`
		: `${doc.version} YANG models not loaded`;
	versionStatusBar.backgroundColor = doc.modelsLoaded
		? undefined
		: new vscode.ThemeColor('statusBarItem.warningBackground');
	versionStatusBar.show();

	const platform = doc.platform || 'unset';
	platformStatusBar.text = `$(server) ${platform}`;
	platformStatusBar.tooltip = `Click to select platform`;
	platformStatusBar.show();
}

async function createNewSRConfig() {
	const options: Array<vscode.QuickPickItem & { nos: NOSId; suffix: string }> = [
		{ label: 'SR Linux (.srl.cfg)', nos: 'srlinux', suffix: '.srl.cfg' },
		{ label: 'SR OS (.sros.cfg)', nos: 'sros', suffix: '.sros.cfg' },
	];
	const picked = await vscode.window.showQuickPick(options, {
		title: 'New SR Config',
		placeHolder: 'Choose config type',
	});
	if (!picked) {
		return;
	}

	const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
	const defaultUri = workspaceUri
		? vscode.Uri.joinPath(workspaceUri, `new${picked.suffix}`)
		: vscode.Uri.file(path.join(os.homedir(), `new${picked.suffix}`));
	const saveUri = await vscode.window.showSaveDialog({
		title: 'Create SR Config',
		saveLabel: 'Create',
		defaultUri,
	});
	if (!saveUri) {
		return;
	}

	const targetUri = ensureUriSuffix(saveUri, picked.suffix);
	if (await uriExists(targetUri)) {
		const overwrite = await vscode.window.showWarningMessage(
			`${path.basename(targetUri.fsPath)} already exists. Overwrite it?`,
			{ modal: true },
			'Overwrite'
		);
		if (overwrite !== 'Overwrite') {
			return;
		}
	}

	const content = configTemplateFor(picked.nos);
	await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(content));
	const document = await vscode.workspace.openTextDocument(targetUri);
	await vscode.window.showTextDocument(document);
}

function configTemplateFor(nos: NOSId): string {
	const nosObj = nosMap[nos];
	const defaultPlatform = nosObj.platforms[0] || '...';
	const version = nosObj.latestVersion();
	return `# version=${version} platform=${defaultPlatform}\n\n`;
}

function ensureUriSuffix(uri: vscode.Uri, suffix: string): vscode.Uri {
	if (uri.fsPath.toLowerCase().endsWith(suffix)) {
		return uri;
	}
	return uri.with({ path: `${uri.path}${suffix}` });
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
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
			description: version === tracked.version ? 'Loaded' : '',
		})),
		{
			title: `${tracked.nos.label}: Select model version`,
			placeHolder: 'Choose the model version for this document',
		}
	);
	if (!picked || picked.label === tracked.version) {
		return;
	}

	await applyServerDirective(editor, tracked.nos.name, 'srpls.setVersion', uri, picked.label);
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

	if (tracked.nos.platforms.length === 0) {
		vscode.window.showWarningMessage(`No known ${tracked.nos.label} platforms are available.`);
		return;
	}

	const currentPlatform = tracked.platform || '';
	const picked = await vscode.window.showQuickPick(
		tracked.nos.platforms.map((p) => ({
			label: p,
			description: p === currentPlatform ? 'Selected' : '',
		})),
		{
			title: `${tracked.nos.label}: Select platform`,
			placeHolder: 'Select the platform for interface & feature awareness. Default: 7220-IXR-D2L',
		}
	);
	if (!picked || picked.label === currentPlatform) {
		return;
	}

	const platform = picked.label;

	await applyServerDirective(editor, tracked.nos.name, 'srpls.setPlatform', uri, platform);
}

async function applyServerDirective(editor: vscode.TextEditor, nos: NOSId, command: string, uri: string, value: string) {
	const client = clients.get(nos);
	if (!client) {
		return;
	}
	try {
		const result = await client.sendRequest('workspace/executeCommand', {
			command,
			arguments: [uri, value],
		});
		if (typeof result !== 'string') {
			return;
		}
		const doc = editor.document;
		const content = doc.getText();
		if (result === content) {
			return;
		}
		const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(content.length));
		await editor.edit((eb) => eb.replace(fullRange, result));
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showWarningMessage(`Could not update directive: ${msg}`);
	}
}

function sortVersionsDescending(versions: string[]): string[] {
	return [...versions].sort((a, b) => semver.rcompare(semver.coerce(a)!, semver.coerce(b)!));
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
