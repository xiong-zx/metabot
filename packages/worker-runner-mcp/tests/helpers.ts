import type {
  CompletionNotification,
  CompletionNotifier,
  ProcessLaunchHooks,
  ProcessLaunchSpec,
  ProcessResult,
  ProcessRunner,
  RunningProcess,
  TrustedPrincipal,
} from '../src/types.js';

interface DeferredProcess {
  pid: number;
  resolve: (result: ProcessResult) => void;
  hooks: ProcessLaunchHooks;
}

export class FakeProcessRunner implements ProcessRunner {
  readonly launches: ProcessLaunchSpec[] = [];
  readonly aborts: number[] = [];
  private readonly processes = new Map<number, DeferredProcess>();
  private nextPid = 4_000;
  private launchRelease?: () => void;
  private launchBarrier?: Promise<void>;
  launchError?: Error;

  holdLaunch(): void {
    this.launchBarrier = new Promise((resolve) => {
      this.launchRelease = resolve;
    });
  }

  releaseLaunch(): void {
    this.launchRelease?.();
    this.launchBarrier = undefined;
    this.launchRelease = undefined;
  }

  async launch(spec: ProcessLaunchSpec, hooks: ProcessLaunchHooks): Promise<RunningProcess> {
    this.launches.push(spec);
    if (this.launchBarrier) await this.launchBarrier;
    if (this.launchError) throw this.launchError;
    const pid = this.nextPid++;
    let resolve!: (result: ProcessResult) => void;
    const completion = new Promise<ProcessResult>((done) => {
      resolve = done;
    });
    this.processes.set(pid, { pid, resolve, hooks });
    return { pid, completion };
  }

  async abort(pid: number): Promise<void> {
    if (this.processes.has(pid)) this.aborts.push(pid);
  }

  activity(pid: number): void {
    this.processes.get(pid)?.hooks.onActivity();
  }

  complete(pid: number, result: ProcessResult): void {
    const process = this.processes.get(pid);
    this.processes.delete(pid);
    process?.resolve(result);
  }
}

export class RecordingNotifier implements CompletionNotifier {
  readonly notifications: CompletionNotification[] = [];
  error?: Error;

  async notify(notification: CompletionNotification): Promise<void> {
    this.notifications.push(notification);
    if (this.error) throw this.error;
  }
}

export const PM_PRINCIPAL: TrustedPrincipal = { role: 'pm', botName: 'bot-a', chatId: 'chat-a' };

export const SUCCESS_RESULT: ProcessResult = {
  exitCode: 0,
  stdout: 'worker finished',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
};
