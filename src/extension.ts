import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as child_process from 'child_process';
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

const SRPLS_REPO = 'srl-labs/srpls';

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
		vscode.window.showErrorMessage(`Failed to prepare srpls: ${msg}`);
		return;
	}

	await Promise.all((Object.values(nosMap) as NOS[]).map(nos => nos.fetchVersionMap()));

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

	// Send latest version and fetch known platforms from each server
	for (const [id, nos] of Object.entries(nosMap) as [NOSId, NOS][]) {
		const client = clients.get(id);
		if (!client) {
			continue;
		}

		const latest = nos.latestVersion();
		if (latest) {
			try {
				await client.sendRequest('workspace/executeCommand', {
					command: 'srpls.setDefaultVersion',
					arguments: [latest],
				});
			} catch { /* server may not support it yet */ }
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
		vscode.commands.registerCommand('srSyntax.gotoPath', async () => {
			await gotoPath();
		}),
	);
}

function registerNotifications(client: lsp.LanguageClient, nos: NOS) {
	client.onNotification('srpls/formatDetected', (params: { uri: string; format: string }) => {
		const doc = documents.get(params.uri);
		if (doc) {
			doc.format = params.format;
		} else {
			documents.set(params.uri, {
				nos, version: '', platform: '',
				format: params.format,
				modelsLoaded: false,
			});
		}
		updateStatusBar();
	});

	client.onNotification('srpls/versionDetected', (params: VersionDetectedParams) => {
		const platform = params.platform || '';
		documents.set(params.uri, {
			nos, version: params.version, platform,
			format: params.format,
			modelsLoaded: params.modelsLoaded,
			loadedVersion: params.loadedVersion,
		});
		updateStatusBar();
	});

	client.onNotification('srpls/modelsNotFound', async (params: ModelsNotFoundParams) => {
		let version = params.version;
		if (!version) { return; }

		if (!nos.isKnownVersion(version)) {
			const nearest = await client.sendRequest('workspace/executeCommand', {
				command: 'srpls.nearestVersion',
				arguments: [version, nos.knownVersions()],
			}) as string;
			if (!nearest) {
				vscode.window.showWarningMessage(
					`No YANG models available for ${nos.label} ${version}`
				);
				return;
			}
			version = nearest;
		}

		if (!await nos.downloadYangModels(version)) {
			return;
		}

		await client.sendRequest('workspace/executeCommand', {
			command: 'srpls.reloadVersion',
			arguments: [params.uri],
		});
	});
}

function updateStatusBar() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		versionStatusBar.hide();
		platformStatusBar.hide();
		vscode.commands.executeCommand('setContext', 'srSyntax.isBraceFormat', false);
		return;
	}

	const doc = documents.get(editor.document.uri.toString());
	if (!doc) {
		versionStatusBar.hide();
		platformStatusBar.hide();
		vscode.commands.executeCommand('setContext', 'srSyntax.isBraceFormat', false);
		return;
	}

	vscode.commands.executeCommand('setContext', 'srSyntax.isBraceFormat', doc.format === 'brace');

	const isFallback = doc.loadedVersion && doc.loadedVersion !== doc.version;
	if (isFallback) {
		versionStatusBar.text = `$(tag) ${doc.nos.label} ${doc.version} $(warning)`;
		versionStatusBar.tooltip = `${doc.version} models not found, using ${doc.loadedVersion}`;
		versionStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	} else if (doc.modelsLoaded) {
		versionStatusBar.text = `$(tag) ${doc.nos.label} ${doc.version} $(pass-filled)`;
		versionStatusBar.tooltip = `${doc.version} YANG models loaded`;
		versionStatusBar.backgroundColor = undefined;
	} else {
		versionStatusBar.text = `$(tag) ${doc.nos.label} ${doc.version} $(error)`;
		versionStatusBar.tooltip = `${doc.version} YANG models not loaded`;
		versionStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
	}
	versionStatusBar.show();

	if (doc.nos.platforms.length > 0) {
		const platform = doc.platform || 'unset';
		platformStatusBar.text = `$(server) ${platform}`;
		platformStatusBar.tooltip = `Click to select platform`;
		platformStatusBar.show();
	} else {
		platformStatusBar.hide();
	}
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
	const cursorLine = editor.selection.active.line;
	const client = getClientForDocument(doc);

	if (!client) {
		vscode.window.showWarningMessage('No language server available for this document');
		return;
	}

	let newContent: string;
	let targetLine = 0;
	try {
		const result = await client.sendRequest('workspace/executeCommand', {
			command: 'srpls.convert',
			arguments: [uri, content, cursorLine],
		}) as { content: string; cursorLine: number } | string;

		if (typeof result === 'string') {
			newContent = result;
		} else if (result && typeof result === 'object' && 'content' in result) {
			newContent = result.content;
			targetLine = result.cursorLine ?? 0;
		} else {
			vscode.window.showWarningMessage('Conversion failed: unexpected server response');
			return;
		}
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

	const pos = new vscode.Position(targetLine, 0);
	editor.selection = new vscode.Selection(pos, pos);
	editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function gotoPath() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }

	const client = getClientForDocument(editor.document);
	if (!client) { return; }

	const pathInput = await vscode.window.showInputBox({
		prompt: 'Enter YANG path',
		placeHolder: '/configure ...',
	});
	if (!pathInput) { 
		return; 
	}

	const uri = editor.document.uri.toString();
	const content = editor.document.getText();

	try {
		const result = await client.sendRequest('workspace/executeCommand', {
			command: 'srpls.gotoPath',
			arguments: [uri, content, pathInput],
		}) as { line: number; exact: boolean } | null;

		if (!result || result.line < 0) {
			return;
		}

		const pos = new vscode.Position(result.line, 0);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);

		if (!result.exact) {
			vscode.window.setStatusBarMessage('Jumped to closest matching path', 3000);
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showWarningMessage(`Go to path failed: ${msg}`);
	}
}

export async function deactivate(): Promise<void> {
	await Promise.all(Array.from(clients.values(), (client) => client.stop()));
}

async function getOrDownloadSrpls(extensionPath: string): Promise<string> {
	const ext = process.platform === 'win32' ? '.exe' : '';

	const plat = PLATFORMS[process.platform];
	const arch = ARCHS[process.arch];
	if (!plat || !arch) {
		throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
	}

	const asset = `srpls-${plat}-${arch}${ext}`;

	let binPath = path.join(extensionPath, 'bin', `srpls${ext}`);
	if (!fs.existsSync(binPath)) {
		const srplsDir = path.join(os.homedir(), '.srpls');
		binPath = path.join(srplsDir, `srpls${ext}`);

		if (!fs.existsSync(binPath)) {
			await installSrpls(binPath, asset, undefined);
		}
	}

	checkForUpdate(binPath, asset).catch(() => {});

	return binPath;
}

function getSrplsVersion(binPath: string): string | null {
	try {
		const out = child_process.execFileSync(binPath, ['-version'], { timeout: 5000 });
		return semver.clean(out.toString().trim());
	} catch {
		return null;
	}
}

async function getLatestRelease(): Promise<{ tag: string; version: string } | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${SRPLS_REPO}/releases/latest`, {
			headers: {
				'Accept': 'application/vnd.github+json',
				'User-Agent': 'sr-vscode',
			},
		});

		if (!res.ok) { 
			return null; 
		}

		const data = await res.json() as { tag_name: string };
		const version = semver.clean(data.tag_name);

		if (!version) { 
			return null; 
		}

		return { 
			tag: data.tag_name, version 
		};
		
	} catch {
		return null;
	}
}

async function checkForUpdate(binPath: string, asset: string): Promise<void> {
	const current = getSrplsVersion(binPath);
	const latest = await getLatestRelease();
	if (!current || !latest) { return; }
	if (!semver.gt(latest.version, current)) { return; }

	const choice = await vscode.window.showInformationMessage(
		`srpls ${latest.tag} is available (current: v${current})`,
		'Update', 'Dismiss'
	);
	if (choice !== 'Update') { return; }

	await installSrpls(binPath, asset, latest.tag);
	const reload = await vscode.window.showInformationMessage(
		`srpls updated to ${latest.tag}. Reload to use the new version.`,
		'Reload'
	);
	if (reload === 'Reload') {
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}

async function installSrpls(binPath: string, asset: string, tag: string | undefined): Promise<void> {
	const dir = path.dirname(binPath);
	fs.mkdirSync(dir, { recursive: true });

	const resolvedTag = tag ?? (await getLatestRelease())?.tag;
	if (!resolvedTag) {
		throw new Error('Could not determine latest srpls release');
	}

	const url = `https://github.com/${SRPLS_REPO}/releases/download/${resolvedTag}/${asset}`;

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Downloading srpls ${resolvedTag}…` },
		async () => {
			const tmpPath = `${binPath}.tmp-${process.pid}`;
			await utils.downloadFile(url, tmpPath);
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
