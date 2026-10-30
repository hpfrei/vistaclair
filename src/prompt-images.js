// Images pasted into a prompt. Claude Code's UserPromptSubmit hook carries the
// prompt text only — no placeholder, no path. The image is announced in the
// session transcript instead: right after the prompt's user record comes a
// meta user record of the same promptId whose text is
//   [Image: source: /tmp/claude-<uid>/<project>/<session>/images/1.png]
// (the same block the model gets in the request). TraceIndex reads these as
// the transcript grows and the store stamps them on the hook as promptImages.

const IMAGE_SOURCE_RE = /\[Image: source: ([^\]\n]+)\]/g;

function imageSourcesInText(text) {
  if (typeof text !== 'string' || !text.includes('[Image: source: ')) return [];
  return [...text.matchAll(IMAGE_SOURCE_RE)].map(m => m[1].trim()).filter(Boolean);
}

// The image paths one transcript record names for its prompt, or null when it
// is not a user record of a prompt or names none.
function promptImagesInRecord(rec) {
  if (rec?.type !== 'user' || !rec.promptId) return null;
  const content = rec.message?.content;
  const texts = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text) : [];
  const paths = texts.flatMap(imageSourcesInText);
  return paths.length ? paths : null;
}

module.exports = { imageSourcesInText, promptImagesInRecord };
