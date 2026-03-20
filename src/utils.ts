import * as fs from 'fs';
import * as stream from 'stream';
import * as tar from 'tar';

export async function downloadFile(url: string, dst: string) {
	const res = await fetch(url, {
		headers: {
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'sr-vscode',
		},
	});

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from ${url}`);
	}

	if (!res.body) {
		throw new Error(`Empty response from ${url}`);
	}

	await stream.promises.pipeline(stream.Readable.fromWeb(res.body), fs.createWriteStream(dst));
}

export async function extractTarball(tarPath: string, dstDir: string, strip = 1) {
	fs.mkdirSync(dstDir, { 
		recursive: true 
	});

	await tar.x({
		file: tarPath, 
		cwd: dstDir, 
		strip 
	});
}

