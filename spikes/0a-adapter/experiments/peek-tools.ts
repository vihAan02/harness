// Which tools does the model see when SendMessage/ListAgents are NOT disallowed? Dump their schemas.
import fs from 'node:fs';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun } from '../lib/session.ts';
const f = makeFixture('peek-tools');
const mock = await startMock({ rawDir: `${f.root}/raw` });
const o: any = hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA });
o.disallowedTools = [];
const { run, done } = startRun('x\n#STEP TEXT y', o);
await done; await mock.close();
const body = JSON.parse(fs.readFileSync(`${f.root}/raw/` + fs.readdirSync(`${f.root}/raw`).find((x) => x.includes('main')), 'utf8'));
console.log('init tools:', run.init.tools.join(','));
console.log('model-visible tools:', body.tools.map((t: any) => t.name + (t.defer_loading ? '(deferred)' : '')).join(','));
for (const t of body.tools.filter((t: any) => /SendMessage|ListAgents|ToolSearch/.test(t.name))) console.log(t.name, JSON.stringify(t.input_schema).slice(0, 600), '\n  desc:', String(t.description).slice(0, 400));
