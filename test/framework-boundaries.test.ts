import { globSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps business and Server client modules independent of Mastra', () => {
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
  const layers = ['application', 'contracts', 'adapters', 'extensions', 'server'];
  const pending = globSync(layers.map(layer => `${layer}/**/*.ts`), { cwd: sourceRoot })
    .map(file => join(sourceRoot, file));
  const visited = new Set<string>();
  const violations: string[] = [];
  const compilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler };

  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName } of importedFiles) {
      const importer = relative(sourceRoot, file);
      if (fileName === 'mastra' || fileName.startsWith('mastra/') || fileName.startsWith('@mastra/')) {
        violations.push(`${importer} -> ${fileName}`);
      } else if (fileName.startsWith('.')) {
        const { resolvedModule } = ts.resolveModuleName(fileName, file, compilerOptions, ts.sys);
        if (!resolvedModule) continue;
        const dependency = relative(sourceRoot, resolvedModule.resolvedFileName);
        if (dependency.startsWith(`mastra${sep}`)) violations.push(`${importer} -> ${dependency}`);
        else if (!dependency.startsWith(`..${sep}`)) pending.push(resolvedModule.resolvedFileName);
      }
    }
  }

  expect(violations.sort()).toEqual([]);
});
