import path from 'node:path';

import type { ArcArtifactStore } from './artifact-store.js';
import type { ArcRunRecord } from './contract.js';
import { ArcError } from './errors.js';

export interface ArcProjectScopeOptions {
  allowedProjectRoots: string[];
  fixedProjectId?: string;
}

/**
 * Trusted server-instance policy. Tool callers cannot expand this scope.
 * Roots are canonicalized once and matched exactly, not as broad ancestors.
 */
export class ArcProjectScope {
  readonly allowedProjectRoots: readonly string[];
  readonly fixedProjectId?: string;
  private readonly rootSet: ReadonlySet<string>;

  constructor(artifacts: ArcArtifactStore, options: ArcProjectScopeOptions) {
    if (!Array.isArray(options.allowedProjectRoots) || options.allowedProjectRoots.length === 0) {
      throw new ArcError('scope_not_configured', 'At least one trusted ARC project root must be configured');
    }
    const roots = options.allowedProjectRoots.map((projectRoot) => {
      const canonical = artifacts.canonicalProjectRoot(projectRoot);
      if (canonical === path.parse(canonical).root) {
        throw new ArcError('scope_not_configured', 'A filesystem root cannot be an ARC project root');
      }
      return canonical;
    });
    this.allowedProjectRoots = [...new Set(roots)].sort();
    this.rootSet = new Set(this.allowedProjectRoots);

    const fixedProjectId = options.fixedProjectId?.trim();
    if (options.fixedProjectId !== undefined && !fixedProjectId) {
      throw new ArcError('scope_not_configured', 'Configured ARC project_id cannot be empty');
    }
    this.fixedProjectId = fixedProjectId;
  }

  authorizeStart(projectId: string, projectRoot: string, artifacts: ArcArtifactStore): string {
    this.authorizeProjectId(projectId);
    const canonical = artifacts.canonicalProjectRoot(projectRoot);
    if (!this.rootSet.has(canonical)) {
      throw new ArcError('scope_denied', 'Project root is outside this ARC server scope');
    }
    return canonical;
  }

  authorizeRequestedProjectId(projectId: string | undefined): string | undefined {
    if (projectId) this.authorizeProjectId(projectId);
    return this.fixedProjectId ?? projectId;
  }

  authorizeRun(run: ArcRunRecord): ArcRunRecord {
    if (!this.rootSet.has(run.project_root)) {
      throw new ArcError('scope_denied', 'ARC run is outside this server scope');
    }
    this.authorizeProjectId(run.project_id);
    return run;
  }

  private authorizeProjectId(projectId: string): void {
    if (this.fixedProjectId && projectId !== this.fixedProjectId) {
      throw new ArcError('scope_denied', 'project_id is outside this ARC server scope');
    }
  }
}
