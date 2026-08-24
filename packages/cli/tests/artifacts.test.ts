import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadArtifactMirrorConfig,
  mirrorProject,
  publishAnnotation,
  type ArtifactMirrorConfig,
} from '../src/artifacts.js';

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(): { config: ArtifactMirrorConfig; project: ArtifactMirrorConfig['projects'][number] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-artifact-mirror-'));
  temporary.push(root);
  const sourceRoot = path.join(root, 'source', 'deliverables');
  const targetRoot = path.join(root, 'project', 'deliverables');
  const annotationsRoot = path.join(root, 'project', 'annotations');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  const project = { projectId: 'aam', sourceRoot, targetRoot, annotationsRoot };
  return {
    config: {
      schemaVersion: 1,
      backupRoot: path.join(root, 'backups'),
      stateRoot: path.join(root, 'state'),
      projects: [project],
    },
    project,
  };
}

describe('metabot artifacts mirror', () => {
  it('strictly adds and deletes authoritative files with rollback snapshots', () => {
    const { config, project } = fixture();
    const first = 'aam_report-tech_sync-design_20260821_v01.md';
    fs.writeFileSync(path.join(project.sourceRoot, first), 'one');
    const add = mirrorProject(config, project, true);
    expect(add.added).toEqual([first]);
    expect(fs.readFileSync(path.join(project.targetRoot, first), 'utf8')).toBe('one');

    fs.unlinkSync(path.join(project.sourceRoot, first));
    const second = 'aam_report-tech_sync-status_20260821_v01.md';
    fs.writeFileSync(path.join(project.sourceRoot, second), 'two');
    const update = mirrorProject(config, project, true);
    expect(update.deleted).toEqual([first]);
    expect(update.added).toEqual([second]);
    expect(update.backupPath).toBeTruthy();
    expect(fs.existsSync(path.join(project.targetRoot, first))).toBe(false);
  });

  it('recovers local edits before restoring the authoritative bytes', () => {
    const { config, project } = fixture();
    const name = 'aam_report-tech_sync-design_20260821_v01.md';
    fs.writeFileSync(path.join(project.sourceRoot, name), 'authority');
    mirrorProject(config, project, true);
    fs.writeFileSync(path.join(project.targetRoot, name), 'local annotation');
    const result = mirrorProject(config, project, true);
    expect(result.replaced).toEqual([name]);
    expect(result.recoveredAnnotations).toEqual([name]);
    expect(fs.readFileSync(path.join(project.targetRoot, name), 'utf8')).toBe('authority');
    const recoveredRoot = path.join(project.annotationsRoot, 'recovered');
    const run = fs.readdirSync(recoveredRoot)[0];
    expect(fs.readFileSync(path.join(recoveredRoot, run, name), 'utf8')).toBe('local annotation');
  });

  it('rejects in-place mutation of the Savio authoritative version', () => {
    const { config, project } = fixture();
    const name = 'aam_report-tech_sync-design_20260821_v01.md';
    fs.writeFileSync(path.join(project.sourceRoot, name), 'v1');
    mirrorProject(config, project, true);
    fs.writeFileSync(path.join(project.sourceRoot, name), 'mutated');
    expect(() => mirrorProject(config, project, true)).toThrow(/changed in place/u);
  });

  it('retains tombstone hashes and rejects reusing a deleted canonical name with new bytes', () => {
    const { config, project } = fixture();
    const name = 'aam_report-tech_sync-design_20260821_v01.md';
    fs.writeFileSync(path.join(project.sourceRoot, name), 'v1');
    mirrorProject(config, project, true);
    fs.unlinkSync(path.join(project.sourceRoot, name));
    mirrorProject(config, project, true);
    fs.writeFileSync(path.join(project.sourceRoot, name), 'different bytes');
    expect(() => mirrorProject(config, project, true)).toThrow(/changed in place/u);
  });

  it('keeps status read-only and validates absolute config paths', () => {
    const { config, project } = fixture();
    const name = 'aam_report-tech_sync-design_20260821_v01.md';
    fs.writeFileSync(path.join(project.sourceRoot, name), 'v1');
    const result = mirrorProject(config, project, false);
    expect(result.applied).toBe(false);
    expect(fs.existsSync(path.join(project.targetRoot, name))).toBe(false);

    const bad = path.join(path.dirname(config.backupRoot), 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ ...config, backupRoot: 'relative' }));
    expect(() => loadArtifactMirrorConfig(bad)).toThrow(/must be absolute/u);
  });

  it('publishes an annotation only as a new canonical authoritative artifact', () => {
    const { config, project } = fixture();
    fs.mkdirSync(project.annotationsRoot, { recursive: true });
    const input = path.join(project.annotationsRoot, 'marked.pdf');
    fs.writeFileSync(input, 'annotation');
    const name = 'aam_review-tech_sync-annotations_lang-zh_20260821_v01.pdf';
    const first = publishAnnotation(config, project, input, name);
    const second = publishAnnotation(config, project, input, name);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(fs.readFileSync(path.join(project.sourceRoot, name), 'utf8')).toBe('annotation');
    expect(() => publishAnnotation(config, project, input, 'notes.pdf')).toThrow(/canonical/u);
  });
});
