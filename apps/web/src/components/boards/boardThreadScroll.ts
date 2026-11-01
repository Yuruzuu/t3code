export function boardThreadScrollAction(
  previousPostIds: readonly string[] | null,
  postIds: readonly string[],
  followEnd: boolean,
) {
  if (postIds.length === 0) return "none";
  if (previousPostIds === null) return "bottom";
  const firstReply = previousPostIds[1];
  if (firstReply !== undefined && postIds.indexOf(firstReply) > 1) return "preserve-anchor";
  return followEnd && previousPostIds.at(-1) !== postIds.at(-1) ? "bottom" : "none";
}
