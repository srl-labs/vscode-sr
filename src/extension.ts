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

interface SrplsBinarySpec {
	assetName: string;
	targetName: string;
}

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
		cmd = await resolveSrplsCommand(context);
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

function getSrplsBinarySpec(): SrplsBinarySpec | undefined {
	let platformName: string | undefined;
	switch (process.platform) {
		case 'linux':
			platformName = 'linux';
			break;
		case 'darwin':
			platformName = 'darwin';
			break;
		case 'win32':
			platformName = 'windows';
			break;
		default:
			return undefined;
	}

	let archName: string | undefined;
	switch (process.arch) {
		case 'x64':
			archName = 'amd64';
			break;
		case 'arm64':
			archName = 'arm64';
			break;
		default:
			return undefined;
	}

	const extension = platformName === 'windows' ? '.exe' : '';
	const binaryName = `srpls-${platformName}-${archName}${extension}`;
	return {
		assetName: binaryName,
		targetName: `srpls-${SRPLS_VERSION}-${platformName}-${archName}${extension}`,
	};
}

function resolveFallbackSrplsCommand(context: vscode.ExtensionContext): string {
	const bin = process.platform === 'win32' ? 'srpls.exe' : 'srpls';
	const localBin = context.asAbsolutePath(path.join('bin', bin));
	if (fs.existsSync(localBin)) {
		return localBin;
	}

	return bin;
}

async function resolveSrplsCommand(context: vscode.ExtensionContext): Promise<string> {
	const fallbackCommand = resolveFallbackSrplsCommand(context);
	const spec = getSrplsBinarySpec();
	if (!spec) {
		return fallbackCommand;
	}

	try {
		return await ensureSrplsBinary(spec);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showWarningMessage(`Failed to download ${spec.assetName}: ${msg}. Falling back to ${fallbackCommand}.`);
		return fallbackCommand;
	}
}

async function ensureExecutableIfNeeded(filePath: string): Promise<void> {
	if (process.platform === 'win32') {
		return;
	}

	await fs.promises.chmod(filePath, 0o755);
}

async function ensureSrplsBinary(spec: SrplsBinarySpec): Promise<string> {
	const srplsDir = path.join(os.homedir(), '.srpls');
	const dstPath = path.join(srplsDir, spec.targetName);
	fs.mkdirSync(srplsDir, { recursive: true });

	if (fs.existsSync(dstPath)) {
		await ensureExecutableIfNeeded(dstPath);
		return dstPath;
	}

	const url = `${SRPLS_RELEASE_BASE_URL}/${spec.assetName}`;
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Downloading srpls ${SRPLS_VERSION}…`,
			cancellable: false,
		},
		async (progress) => {
			const tmpPath = path.join(srplsDir, `${spec.targetName}.tmp-${process.pid}-${Date.now()}`);

			progress.report({ message: `Fetching ${spec.assetName}…` });
			await utils.downloadFile(url, tmpPath);
			await ensureExecutableIfNeeded(tmpPath);

			progress.report({ message: 'Installing binary…' });
			try {
				await fs.promises.rename(tmpPath, dstPath);
			} catch (e) {
				if (!fs.existsSync(dstPath)) {
					throw e;
				}
				try { await fs.promises.unlink(tmpPath); } catch { /* temporary file already removed */ }
			}
		}
	);

	return dstPath;
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
