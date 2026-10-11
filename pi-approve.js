/**
 * Pion tool-approval extension (loaded by pi with `-e pi-approve.js`).
 *
 * pi itself never asks before running a tool (docs/security.md). This extension adds the
 * missing gate for the Obsidian panel: every tool call whose name matches the
 * PI_PION_APPROVE_TOOLS env var (comma-separated, or `*` for all) is routed through
 * `ctx.ui.confirm` — which, in `--mode rpc`, surfaces to the plugin as an
 * `extension_ui_request` and blocks until the user answers in a native Obsidian modal.
 *
 * In TUI/json mode the confirm would render in a terminal the plugin cannot drive, so
 * Pion only loads this extension together with `--mode rpc`; a missing or empty env var
 * disables the gate entirely.
 */
export default function (pi) {
  const raw = String(process.env.PI_PION_APPROVE_TOOLS || '').trim();
  if (!raw) return;

  const allowAll = raw === '*';
  const names = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));

  pi.on('tool_call', async (event, ctx) => {
    const name = String(event.toolName || '');
    if (!name) return;
    if (!allowAll && !names.has(name)) return;

    let argsPreview = '';
    try {
      argsPreview = JSON.stringify(event.args || {}, null, 2);
      if (argsPreview.length > 600) argsPreview = argsPreview.slice(0, 600) + '\n…';
    } catch (e) {
      argsPreview = String(event.args || '');
    }

    const ok = await ctx.ui.confirm('Pion — 允许这次工具调用？', name + '\n\n' + argsPreview);
    if (!ok) return { block: true, reason: name + ' 未获批准（在面板中拒绝）' };
  });
}
