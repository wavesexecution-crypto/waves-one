// Exec router: maps the 17 known job kinds to executors. Anything else is
// refused (the agent never handles credentials or unknown work). Emits
// started/finished progress events through ctx.onEvent.
import { execFs } from './fs.mjs';
import { execTerm } from './term.mjs';
import { execProc } from './proc.mjs';
import { execBrowser } from './browser.mjs';
import { execGit } from './git.mjs';
import { execNet } from './net.mjs';

export async function executeJob(kind, params, ctx) {
  ctx.onEvent?.('info', `Started ${kind}`);
  let result;
  try {
    switch (kind) {
      case 'fs.list':
      case 'fs.read':
      case 'fs.write':
      case 'fs.mkdir':
      case 'fs.move':
      case 'fs.delete':
        result = await execFs(kind, params, ctx);
        break;
      case 'term.exec':
        result = await execTerm(params, ctx);
        break;
      case 'proc.list':
      case 'proc.start':
      case 'proc.stop':
        result = await execProc(kind, params, ctx);
        break;
      case 'browser.open':
        result = await execBrowser(params, ctx);
        break;
      case 'git.status':
      case 'git.log':
      case 'git.diff':
      case 'git.commit':
      case 'git.push':
        result = await execGit(kind, params, ctx);
        break;
      case 'net.download':
        result = await execNet(params, ctx);
        break;
      default:
        result = { ok: false, error: `Refused: unknown or unsupported job kind '${kind}'` };
    }
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err) };
  }
  if (!result || typeof result.ok !== 'boolean') {
    result = { ok: false, error: 'Executor returned an invalid result' };
  }
  ctx.onEvent?.(
    result.ok ? 'info' : 'warning',
    `${result.ok ? 'Finished' : 'Failed'} ${kind}${result.error ? `: ${result.error}` : ''}`,
  );
  return result;
}
