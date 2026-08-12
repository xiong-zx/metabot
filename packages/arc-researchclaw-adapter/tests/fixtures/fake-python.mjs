#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

if (process.argv[2] !== '-m') {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  if (payload.action === 'probe') {
    process.stdout.write(JSON.stringify({ success: true, version: '0.5.0', stage_count: 23, package_path: import.meta.filename }));
    process.exit(0);
  }
  const args = payload.arguments;
  const runDir = path.join(payload.artifacts_dir, args.run_id);
  const hitlDir = path.join(runDir, 'hitl');
  mkdirSync(hitlDir, { recursive: true });
  let result;
  switch (payload.tool) {
    case 'hitl_get_status':
      result = {
        success: true,
        run_id: args.run_id,
        needs_input: existsSync(path.join(hitlDir, 'waiting.json')),
        ...(existsSync(path.join(hitlDir, 'waiting.json'))
          ? { waiting: JSON.parse(readFileSync(path.join(hitlDir, 'waiting.json'), 'utf8')) }
          : {}),
      };
      break;
    case 'hitl_approve_stage':
      writeFileSync(path.join(hitlDir, 'response.json'), JSON.stringify({ action: 'approve', message: args.message ?? '' }));
      result = { success: true, action: 'approve' };
      break;
    case 'hitl_reject_stage':
      writeFileSync(path.join(hitlDir, 'response.json'), JSON.stringify({ action: 'reject', message: args.reason ?? '' }));
      result = { success: true, action: 'reject' };
      break;
    case 'hitl_inject_guidance':
      mkdirSync(path.join(hitlDir, 'guidance'), { recursive: true });
      writeFileSync(path.join(hitlDir, 'guidance', `stage_${String(args.stage).padStart(2, '0')}.md`), args.guidance);
      result = { success: true, stage: args.stage, guidance_length: args.guidance.length };
      break;
    case 'hitl_view_output': {
      const stageDir = path.join(runDir, `stage-${String(args.stage).padStart(2, '0')}`);
      const files = existsSync(stageDir) ? ['stage-output.md'] : [];
      result = { success: true, stage: args.stage, files: files.map((name) => ({ name, is_dir: false })) };
      break;
    }
    default:
      result = { success: false, error: `unknown tool ${payload.tool}` };
  }
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const runDir = value('--output');
const topic = value('--topic');
mkdirSync(path.join(runDir, 'deliverables'), { recursive: true });
mkdirSync(path.join(runDir, 'stage-01'), { recursive: true });
writeFileSync(path.join(runDir, 'stage-01', 'stage-output.md'), '# Official stage output\n');

if (topic.includes('WAIT_FOR_HITL')) {
  const hitlDir = path.join(runDir, 'hitl');
  mkdirSync(hitlDir, { recursive: true });
  writeFileSync(path.join(hitlDir, 'session.json'), JSON.stringify({ mode: 'gate-only', state: 'waiting_human' }));
  writeFileSync(path.join(hitlDir, 'waiting.json'), JSON.stringify({ stage: 1, stage_name: 'TOPIC_INIT', reason: 'gate_approval' }));
  while (!existsSync(path.join(hitlDir, 'response.json'))) await new Promise((resolve) => setTimeout(resolve, 25));
  unlinkSync(path.join(hitlDir, 'response.json'));
  unlinkSync(path.join(hitlDir, 'waiting.json'));
}

if (topic.includes('LONG_RUNNING')) await new Promise((resolve) => setTimeout(resolve, 30_000));
writeFileSync(path.join(runDir, 'deliverables', 'paper_final.md'), '# Official paper\n');
writeFileSync(path.join(runDir, 'checkpoint.json'), JSON.stringify({ last_completed_stage: 23, last_completed_name: 'CITATION_VERIFY' }));
writeFileSync(path.join(runDir, 'pipeline_summary.json'), JSON.stringify({
  run_id: path.basename(runDir),
  stages_executed: 23,
  stages_done: 23,
  stages_paused: 0,
  stages_failed: 0,
  final_stage: 23,
  final_status: 'done',
}));
