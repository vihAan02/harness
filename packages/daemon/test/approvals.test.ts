// An approval that lands while harnessd is reading where a request stands is an approval, never a denial (D-52, D-34,
// D-114, D-118). approve() grants first and then removes the request; a reader that checked the grants just before the
// grant and the requests just after the removal saw neither, and took the approval for a denial. Under load that window
// is wide enough: it failed peer-reconcile's publish once in eleven full runs on 2026-10-12.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Approvals } from '../src/approvals.ts';
import { tempDir, tempHome } from './fixtures.ts';

const ask = (a: Approvals) => a.request({ projectId: 'prj_a', taskId: 'T-1', command: 'publish T-1', manifests: [], hash: 'h'.repeat(64), kind: 'publish' });

test('a request approved between the two reads is approved; a denied one is denied; an open one is pending', () => {
  const { dir, cleanup } = tempDir('approvals');
  try {
    const home = tempHome(dir);
    // The race, made exact: the human approves as soon as the reader has checked the grants and looks for the request.
    class Racing extends Approvals {
      armed = false;
      override pending() {
        if (this.armed) { this.armed = false; for (const p of super.pending()) new Approvals(this.home).approve(p.id); }
        return super.pending();
      }
    }
    const a = new Racing(home);
    const req = ask(a);
    assert.equal(a.decision('prj_a', req.hash, req.id), 'pending', 'asked and not answered');
    a.armed = true;
    assert.equal(a.decision('prj_a', req.hash, req.id), 'approved', 'approved between the two reads');
    // The check harnessd made before, grants and then requests once each, under the same race: it reads a denial.
    const r = new Racing(tempHome(fs.mkdtempSync(`${dir}/r-`)));
    const again = ask(r);
    r.armed = true;
    const before = r.isApproved('prj_a', again.hash) ? 'approved' : r.pending().some((x) => x.id === again.id) ? 'pending' : 'denied';
    assert.equal(before, 'denied', 'the race is real');
    assert.equal(r.decision('prj_a', again.hash, again.id), 'approved', 'and the grant was there all along');
    // The controls: a denial is a denial, and a grant read first needs no second look.
    const b = new Approvals(tempHome(fs.mkdtempSync(`${dir}/b-`)));
    const other = ask(b);
    b.deny(other.id);
    assert.equal(b.decision('prj_a', other.hash, other.id), 'denied');
    const c = new Approvals(tempHome(fs.mkdtempSync(`${dir}/c-`)));
    const third = ask(c);
    c.approve(third.id);
    assert.equal(c.decision('prj_a', third.hash, third.id), 'approved');
  } finally { cleanup(); }
});
