import { useAtomValue } from "@effect/atom-react";
import { createMessageBoardAtoms } from "@t3tools/client-runtime/message-board";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";

export const messageBoardAtoms = createMessageBoardAtoms(connectionAtomRuntime);
const zeroUnread = Atom.make(0);

export function useBoardUnreadCount() {
  const environmentId = usePrimaryEnvironmentId();
  return useAtomValue(
    environmentId === null ? zeroUnread : messageBoardAtoms.unreadCount(environmentId),
  );
}
