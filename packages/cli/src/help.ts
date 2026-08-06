export function print(): void {
  process.stdout.write(
    `metabot — unified CLI for the metabot-core ecosystem.

Usage: metabot <subcommand> [args]

Subcommands:
  memory <cmd> [args]   shared knowledge / notes
                        e.g. metabot memory search "auth" | metabot memory health
  skills <cmd> [args]   skill registry (alias: skill)
                        e.g. metabot skills list | metabot skills install <name>
  agents <cmd> [args]   agent registry (address book for peer bots)
                        e.g. metabot agents list | metabot agents talk <peer>/<bot> <chatId> "<msg>"
  inbox <cmd> [args]    central inbox for CLI agents (no resident bridge needed)
                        e.g. metabot inbox register | metabot inbox poll --loop
  teams <cmd> [args]    MetaBot Agent Teams (local bridge)
                        e.g. metabot teams dispatch demo worker "review PR" | metabot teams next demo worker
  t5t <cmd> [args]      daily team status portal (board / projects / entries)
                        e.g. metabot t5t board | metabot t5t push <slug> <date> "<item>"
  help                  this message (also --help, -h, or bare invocation)

Each subcommand has its own help; pass --help through to see it:
  metabot memory --help
  metabot skills --help
  metabot agents --help
  metabot inbox --help
  metabot teams --help
  metabot t5t --help

Env:
  METABOT_CORE_URL              default http://localhost:9200
  METABOT_CORE_TOKEN            bearer token (or write to ~/.metabot-core/token)
  METABOT_CORE_AGENT_BUS_URL    optional override of the agent-registry base URL (falls back to METABOT_CORE_URL)
`,
  );
}
