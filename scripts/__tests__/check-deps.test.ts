import { afterEach, describe, expect, it } from 'vitest';
import { check, classifyFile, parseImports, resolveTarget, scan } from '../check-deps';
import { makeTempRepo, runScript } from './helpers';

/** 用 路径 → 源码 构造文件集并返回违规的「文件 ← 说明符」列表 */
const violationsOf = (files: Record<string, string>): string[] =>
  check(new Map(Object.entries(files))).map((v) => `${v.file} ← ${v.spec}`);

const S = 'packages/shared/src';

describe('parseImports', () => {
  it('解析静态、类型、副作用、动态、require 与 export from', () => {
    const src = [
      "import a from './a';",
      "import type { B } from './b';",
      "import { c, type D, e as f } from './c';",
      "import * as ns from './ns';",
      "import './side-effect';",
      "export * from './re';",
      "export { g } from './g';",
      'import {',
      '  h,',
      '  i,',
      "} from './multi';",
      "const m = await import('./dyn');",
      "const r = require('./req');",
    ].join('\n');
    const imps = parseImports(src);
    expect(imps.map((i) => [i.spec, i.kind])).toEqual([
      ['./a', 'static'],
      ['./b', 'static'],
      ['./c', 'static'],
      ['./ns', 'static'],
      ['./side-effect', 'side-effect'],
      ['./re', 'static'],
      ['./g', 'static'],
      ['./multi', 'static'],
      ['./dyn', 'dynamic'],
      ['./req', 'require'],
    ]);
    expect(imps[1]!.typeOnly).toBe(true);
    expect(imps[2]!.names).toEqual(['c', 'D', 'e']);
    expect(imps[3]!.names).toEqual(['*']);
    expect(imps[0]!.names).toEqual(['default']);
  });

  it('注释与字符串中的 import 不计', () => {
    const src = [
      "// import x from '../view/a';",
      "/* export * from 'node:fs'; */",
      'const s = "import y from \'../ai/policy\'";',
      "const t = `import('node:path')`;",
      "import real from './real';",
    ].join('\n');
    expect(parseImports(src).map((i) => i.spec)).toEqual(['./real']);
  });

  it('import.meta 与 obj.import(...) 不被当成导入', () => {
    expect(parseImports("const u = import.meta.url; loader.import('x'); obj.require('y');")).toEqual([]);
  });
});

describe('classifyFile / resolveTarget', () => {
  it('按路径归入模块，识别测试文件', () => {
    expect(classifyFile(`${S}/engine/core/flow.ts`)).toMatchObject({ module: 'shared/engine', isTest: false });
    expect(classifyFile(`${S}/engine/testing/builders.ts`)).toMatchObject({ module: 'shared/engine', isTest: true });
    expect(classifyFile(`${S}/index.ts`)).toMatchObject({ module: 'shared/root' });
    expect(classifyFile('packages/shared/vitest.config.ts')).toMatchObject({ module: 'shared/tooling' });
    expect(classifyFile('apps/server/src/game/GameRunner.ts')).toMatchObject({ module: 'server/game' });
    expect(classifyFile('apps/server/test/unit/x.test.ts')).toMatchObject({ module: 'server/test', isTest: true });
    expect(classifyFile('apps/client/src/net/router.ts')).toMatchObject({ module: 'client/src', isTest: false });
  });

  it('解析相对路径、目录 index 与 @rich4/shared 子路径', () => {
    const ctx = {
      files: new Set([`${S}/engine/index.ts`, `${S}/engine/types/state.ts`]),
      sharedExports: { './engine': './src/engine/index.ts', './engine-testing': './src/engine/testing/index.ts' },
    };
    expect(resolveTarget(`${S}/view/project.ts`, '../engine', ctx)).toEqual({
      kind: 'internal',
      pkg: 'shared',
      unit: 'shared/engine/index',
    });
    expect(resolveTarget(`${S}/view/project.ts`, '../engine/types/state.js', ctx)).toMatchObject({
      unit: 'shared/engine/types/state',
    });
    expect(resolveTarget('apps/client/src/a.ts', '@rich4/shared/engine-testing', ctx)).toMatchObject({
      unit: 'shared/engine/testing/index',
    });
    expect(resolveTarget('apps/client/src/a.ts', 'node:fs', ctx)).toEqual({ kind: 'node', name: 'node:fs' });
    expect(resolveTarget('apps/client/src/a.ts', 'fs', ctx)).toEqual({ kind: 'node', name: 'fs' });
    expect(resolveTarget('apps/client/src/a.ts', '@fontsource/fredoka/400.css', ctx)).toEqual({
      kind: 'external',
      name: '@fontsource/fredoka',
    });
  });
});

describe('check：分层表', () => {
  it('合法 import 放行', () => {
    expect(
      violationsOf({
        [`${S}/util/index.ts`]: "export * from './hash';",
        [`${S}/util/hash.ts`]: 'export const h = 1;',
        [`${S}/geom/viewWindow.ts`]: "import { h } from '../util/hash';",
        [`${S}/data/maps/mapIndex.ts`]: "import { inViewWindow } from '../../geom/viewWindow';",
        [`${S}/data/maps/schema.ts`]: "import { z } from 'zod';\nimport { h } from '../../util';",
        [`${S}/engine/core/flow.ts`]:
          "import { h } from '../../util/hash';\nimport { inViewWindow } from '../../geom/viewWindow';\nimport type { MapDef } from '../../data/maps/types';\nimport { ctx } from './ctx';",
        [`${S}/engine/core/postPatch.ts`]: 'export const applyPostPatch = 1;',
        [`${S}/view/project.ts`]:
          "import { applyPostPatch } from '../engine/core/postPatch';\nimport type { GameEvent } from '../engine/types/events';",
        [`${S}/minigames/penguin/sim.ts`]: "import { watcom } from '../../util/rng/watcom';",
        [`${S}/ai/policy.ts`]:
          "import { calcToll } from '../engine/selectors';\nimport type { GameView } from '../view/types';\nimport { inViewWindow } from '../geom/viewWindow';",
        [`${S}/net/protocol.ts`]:
          "import type { PlayerIntent } from '../engine/types/intent';\nimport type { GameView } from '../view/types';\nimport type { MinigameId } from '../minigames/types';",
        [`${S}/index.ts`]: "export * from './engine';\nexport * from './ai';",
        'apps/server/src/game/GameRunner.ts': "import { createEngine } from '@rich4/shared/engine';",
        'apps/server/src/net/io.ts':
          "import { Server } from 'socket.io';\nimport { readFile } from 'node:fs/promises';",
        'apps/server/test/helpers/stub.ts': "import { scenario } from '@rich4/shared/engine-testing';",
        'apps/server/scripts/simulate.ts':
          "import { scenario } from '@rich4/shared/engine-testing';\nimport os from 'node:os';",
        'apps/client/src/net/router.ts':
          "import { applyPostPatch, EVENT_META } from '@rich4/shared/engine';\nimport type { GameView } from '@rich4/shared/view';\nimport { io } from 'socket.io-client';",
        'apps/client/src/game/viewFold.test.ts': "import { createEngine } from '@rich4/shared/engine';",
        'tools/extract/src/map/build.ts':
          "import { validateMap } from '@rich4/shared/data';\nimport { readFile } from 'node:fs/promises';",
      }),
    ).toEqual([]);
  });

  it('违规 import 被拦', () => {
    expect(
      violationsOf({
        [`${S}/engine/index.ts`]: 'export const createEngine = 1;',
        [`${S}/util/hash.ts`]: "import { x } from '../data/tables';",
        [`${S}/data/maps/validate.ts`]: "import { flow } from '../../engine/core/flow';",
        [`${S}/engine/core/flow.ts`]: "import type { GameView } from '../../view/types';",
        [`${S}/engine/core/io.ts`]: "import { readFileSync } from 'node:fs';",
        [`${S}/engine/rules/debug.ts`]: "import { builders } from '../testing/builders';",
        [`${S}/minigames/penguin/sim.ts`]: "import { TABLES } from '../../data/tables';",
        [`${S}/ai/policy.ts`]: "import { runFlow } from '../engine/flow/turn';",
        [`${S}/ai/view.ts`]: "import type { GameState } from '../engine/types/state';",
        [`${S}/view/project.ts`]: "import { createEngine } from '../engine';",
        [`${S}/net/schemas.ts`]: "import { applyAction } from '../engine/api';",
        'apps/server/src/game/Deadlines.ts': "import { setTimeout } from 'node:timers';",
        'apps/server/src/game/Broadcast.ts': "import type { Server } from 'socket.io';",
        'apps/server/src/rooms/Room.ts': "import { scenario } from '@rich4/shared/engine-testing';",
        'apps/client/src/ai.ts': "import { OriginalAiPolicy } from '@rich4/shared/ai';",
        'apps/client/src/fs.ts': "import { readFile } from 'node:fs';",
        'apps/client/src/debug.ts': "import { scenario } from '@rich4/shared/engine-testing';",
        'apps/client/src/extract.test.ts': "import { build } from '@rich4/extract';",
        'tools/extract/src/cli.ts': "import { Room } from '../../../apps/server/src/rooms/Room';",
      }),
    ).toEqual([
      'apps/client/src/ai.ts ← @rich4/shared/ai',
      'apps/client/src/debug.ts ← @rich4/shared/engine-testing',
      'apps/client/src/extract.test.ts ← @rich4/extract',
      'apps/client/src/fs.ts ← node:fs',
      'apps/server/src/game/Broadcast.ts ← socket.io',
      'apps/server/src/game/Deadlines.ts ← node:timers',
      'apps/server/src/rooms/Room.ts ← @rich4/shared/engine-testing',
      `${S}/ai/policy.ts ← ../engine/flow/turn`,
      `${S}/ai/view.ts ← ../engine/types/state`,
      `${S}/data/maps/validate.ts ← ../../engine/core/flow`,
      `${S}/engine/core/flow.ts ← ../../view/types`,
      `${S}/engine/core/io.ts ← node:fs`,
      `${S}/engine/rules/debug.ts ← ../testing/builders`,
      `${S}/minigames/penguin/sim.ts ← ../../data/tables`,
      `${S}/net/schemas.ts ← ../engine/api`,
      `${S}/util/hash.ts ← ../data/tables`,
      `${S}/view/project.ts ← ../engine`,
      'tools/extract/src/cli.ts ← ../../../apps/server/src/rooms/Room',
    ]);
  });

  it('shared/ai 访问 state.secret 被拦（注释里不算）', () => {
    const v = check(
      new Map([[`${S}/ai/rng.ts`, '// 不要读 state.secret\nexport const seed = (s: S) => s.secret.aiSeed;']]),
    );
    expect(v.map((x) => [x.line, x.message])).toEqual([[2, 'shared/ai 不得访问 state.secret']]);
  });

  it('测试文件豁免分层表，但仍不得依赖 @rich4/extract 或越过包边界', () => {
    expect(
      violationsOf({
        [`${S}/ai/fuzz.legality.test.ts`]: "import { createEngine } from '../engine/api';\nimport fs from 'node:fs';",
        [`${S}/ai/testing/selfplay.ts`]: "import { createEngine } from '../../engine/api';",
        [`${S}/engine/rules/x.test.ts`]: "import { anchors } from '@rich4/extract/anchors';",
        [`${S}/view/x.test.ts`]: "import { Room } from '../../../../apps/server/src/rooms/Room';",
      }),
    ).toEqual([
      `${S}/engine/rules/x.test.ts ← @rich4/extract/anchors`,
      `${S}/view/x.test.ts ← ../../../../apps/server/src/rooms/Room`,
    ]);
  });
});

describe('scan（临时仓库）', () => {
  let cleanup = (): void => {};
  afterEach(() => cleanup());

  it('从磁盘读取并报告行号；CLI 违规退出 1、合法退出 0', () => {
    const repo = makeTempRepo('deps');
    cleanup = repo.cleanup;
    repo.write(`${S}/engine/index.ts`, "export * from './api';\n");
    repo.write(`${S}/engine/api.ts`, "import { h } from '../util/hash';\nexport const createEngine = () => h;\n");
    repo.write(`${S}/util/hash.ts`, 'export const h = 1;\n');
    repo.write('apps/client/src/main.ts', "import type { X } from '@rich4/shared/engine';\n");
    expect(scan(repo.root).violations).toEqual([]);
    expect(runScript('check-deps.ts', repo.root).code).toBe(0);

    repo.write(`${S}/util/hash.ts`, "export const h = 1;\n\nimport { createEngine } from '../engine';\n");
    const { violations } = scan(repo.root);
    expect(violations.map((v) => `${v.file}:${v.line}`)).toEqual([`${S}/util/hash.ts:3`]);
    const bad = runScript('check-deps.ts', repo.root);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain(`${S}/util/hash.ts:3`);
  });
});
