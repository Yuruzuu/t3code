const MENTION = /(?<![\w@[])@([A-Za-z][\w-]*)(?:\[([^\]\s]+)\])?/g;

export function formatBoardMention(name: string, threadId: string) {
  return `@${name}[${encodeURIComponent(threadId)}]`;
}

export function collectBoardMentions(text: string) {
  return [...text.matchAll(MENTION)].flatMap((match) => {
    try {
      return [
        {
          source: match[0],
          name: match[1]!,
          threadId: match[2] === undefined ? undefined : decodeURIComponent(match[2]),
          start: match.index,
          end: match.index + match[0].length,
        },
      ];
    } catch {
      return [];
    }
  });
}
