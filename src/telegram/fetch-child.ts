import { fileStore } from '../store/file.ts';
import { TOKEN } from './fake-server.ts';
import { fetchCall, fileDownload } from './fetch.ts';
import { fetchFile } from './fetch-file.ts';

const [storeDir = '', cache = '', apiUrl = '', id = ''] = process.argv.slice(2);
process.stdout.write('started\n');
const result = await fetchFile({ id, store: fileStore(storeDir), call: fetchCall({ token: TOKEN, apiUrl }), cache, chat: 111, allow: [111], from: { download: fileDownload({ token: TOKEN, apiUrl }) } });
process.stdout.write(`${JSON.stringify(result)}\n`);
