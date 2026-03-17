import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as utils from './utils';
import * as vscode from 'vscode';

export type NOSId = 'sros' | 'srlinux';

export interface VersionDetectedParams {
	uri: string;
	version: string;
	platform: string;
}

export interface ModelsNotFoundParams {
	uri: string;
	version: string;
}

// OPEN docuemnts that match against our NOS <nos>.cfg
export interface TrackedDocument {
	nos: NOS;
	version: string;
	platform: string;
}

interface ModelEntry {
	version: string;
	model: string;
}

export class NOS {
	public readonly yangDir: string;
	private versionMap: Record<string, string> | undefined;
	private downloading = new Set<string>();

	constructor(
		public readonly name: NOSId,
		public readonly label: string,
		public readonly cfgSuffix: string,
		private readonly dirPrefix: string,
	) {
		this.yangDir = path.join(os.homedir(), '.srpls', name, 'yang');
	}

	private getVersionMap(): Record<string, string> {
		if (!this.versionMap) {
			const jsonPath = path.join(__dirname, '..', this.name, 'models.json');
			const raw: Record<string, ModelEntry[]> = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
			const entries = raw[this.name];
			this.versionMap = {};
			for (const e of entries) {
				this.versionMap[e.version] = e.model;
			}
		}
		return this.versionMap!;
	}

	knownVersions(): string[] {
		return Object.keys(this.getVersionMap());
	}

	latestVersion(): string {
		const versions = this.knownVersions();
		versions.sort((a, b) => {
			const [aMaj, aMin] = a.split('.').map(Number);
			const [bMaj, bMin] = b.split('.').map(Number);
			return bMaj - aMaj || bMin - aMin;
		});
		return versions[0];
	}

	isKnownVersion(version: string): boolean {
		return version in this.getVersionMap();
	}

	modelDir(version: string): string {
		return path.join(this.yangDir, `${this.dirPrefix}${version}`);
	}

	async downloadYangModels(version: string): Promise<boolean> {
		const dir = this.modelDir(version);
		if (fs.existsSync(dir)) {
			return true;
		}

		if (this.downloading.has(version)) {
			return false;
		}

		const url = this.getVersionMap()[version];
		if (!url) {
			vscode.window.showErrorMessage(`No YANG models available for ${this.label} ${version}`);
			return false;
		}

		this.downloading.add(version);
		try {
			return await vscode.window.withProgress(
				{
					location: 15,
					title: `Downloading ${this.label} ${version} YANG models…`,
					cancellable: false,
				},
				async (progress) => {
					const tarPath = path.join(os.tmpdir(), `${this.name}_${version}.tar.gz`);

					progress.report({ message: 'Downloading…' });
					await utils.downloadFile(url, tarPath);

					progress.report({ message: 'Extracting models…' });
					await utils.extractTarball(tarPath, dir);

					try { fs.unlinkSync(tarPath); } catch { /* already cleaned up */ }
					return true;
				}
			) ?? false;
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to download ${this.label} ${version} YANG models: ${e}`);
			return false;
		} finally {
			this.downloading.delete(version);
		}
	}
}
