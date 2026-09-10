module.exports = function(ctx) {
  if (!Array.isArray(ctx.body.tools)) return;

  const REMOVED = new Set([
    'CronCreate', 'CronDelete',
    'EnterWorktree', 'ExitWorktree',
    'NotebookEdit',
    'PushNotification',
    'RemoteTrigger',
    'ScheduleWakeup',
    'ShareOnboardingGuide',
    'CronList',
    'Artifact',
    'SendFeedback',
    'DesignSync',
    'EndConversation'
  ]);
  const REMOVED_PREFIXES = ['mcp__claude_ai_'];

  const before = ctx.body.tools.length;
  ctx.body.tools = ctx.body.tools.filter(t =>
    t != null &&
    !REMOVED.has(t.name) &&
    !REMOVED_PREFIXES.some(p => t.name?.startsWith(p))
  );
  const removed = before - ctx.body.tools.length;
  /*if (removed > 0) {
    console.log(`[rule:unsafe-tool-filter] Stripped ${removed} unsafe tools`);
  }*/
};
