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
	modelsLoaded: boolean;
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
	modelsLoaded: boolean;
}

export type TagParser = (tag: string) => string | null;

export class NOS {
	public readonly yangDir: string;
	public platforms: string[] = [];
	private versionMap: Record<string, string> | undefined;
	private downloading = new Set<string>();

	constructor(
		public readonly name: NOSId,
		public readonly label: string,
		public readonly cfgSuffix: string,
		private readonly dirPrefix: string,
		public readonly repo: string,
		private readonly parseTag: TagParser,
	) {
		this.yangDir = path.join(os.homedir(), '.srpls', name, 'yang');
	}

	async fetchVersionMap(): Promise<void> {
		const tags = await this.fetchAllTags();
		this.versionMap = {};
		for (const tag of tags) {
			const version = this.parseTag(tag);
			if (!version) { continue; }
			this.versionMap[version] = `https://api.github.com/repos/${this.repo}/tarball/refs/tags/${tag}`;
		}
	}

	private async fetchAllTags(): Promise<string[]> {
		const tags: string[] = [];
		let page = 1;
		while (true) {
			const res = await fetch(
				`https://api.github.com/repos/${this.repo}/tags?per_page=100&page=${page}`,
				{
					headers: {
						'Accept': 'application/vnd.github+json',
						'User-Agent': 'sr-vscode',
					},
				}
			);
			if (!res.ok) { break; }
			const data = await res.json() as Array<{ name: string }>;
			if (data.length === 0) { break; }
			tags.push(...data.map(t => t.name));
			if (data.length < 100) { break; }
			page++;
		}
		return tags;
	}

	private getVersionMap(): Record<string, string> {
		return this.versionMap ?? {};
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
