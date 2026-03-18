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

const nosMap: Record<NOSId, NOS> = {
	sros,
	srlinux,
};

const clients = new Map<NOSId, lsp.LanguageClient>();
const documents = new Map<string, TrackedDocument>();

export async function activate(context: vscode.ExtensionContext) {
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
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
		cmd = await getOrDownloadSrpls();
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
		}),
		vscode.commands.registerCommand('srSyntax.toggleFormat', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}
			await convertDocument(editor);
		}),
	);
}

function registerNotifications(client: lsp.LanguageClient, nos: NOS) {
	client.onNotification('srpls/versionDetected', (params: VersionDetectedParams) => {
		documents.set(params.uri, { nos, version: params.version, platform: params.platform });
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

	const platform = doc.platform ? ` (${doc.platform})` : '';
	statusBar.text = `${doc.nos.label} ${doc.version}${platform}`;
	statusBar.tooltip = `${doc.nos.label} model version ${doc.version}${platform}`;
	statusBar.show();
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

async function getOrDownloadSrpls(): Promise<string> {
	const plat = PLATFORMS[process.platform];
	const arch = ARCHS[process.arch];
	if (!plat || !arch) {
		throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
	}

	const ext = process.platform === 'win32' ? '.exe' : '';
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
