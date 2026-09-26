# test/：临时调试脚本

这个目录只放**临时调试脚本**（一次性的排查、实验、数据探查等），按项目约定统一放在这里，不散落到各个包里。

- 这里不是正式测试。单元测试与集成测试放在各包自己的位置：`packages/shared/src/**/*.test.ts`、`apps/server/test/`、`apps/client/src/**/*.test.ts`、`tools/extract/test/`、`scripts/__tests__/`，端到端测试放在 `e2e/`。
- 脚本可以用 `npx tsx test/<脚本>.ts` 运行。需要长期保留的逻辑请整理后移到对应包或 `scripts/`。
- **不要**在这里保存原版文件、从原版文件提取的数据或其输出（这些只能放在 `original/`、`.cache/`、`rich4-data/`）；`npm run check:no-original` 同样会检查本目录。
- 本目录不进入 Docker 构建上下文（见 `.dockerignore`）。
