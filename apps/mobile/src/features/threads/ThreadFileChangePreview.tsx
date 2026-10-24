import { getFileChangePreview } from "@t3tools/client-runtime/work-log/file-change-preview";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

export function ThreadFileChangePreview(props: {
  readonly item: Extract<OrchestrationV2TurnItem, { readonly type: "file_change" }>;
}) {
  const preview = getFileChangePreview(props.item);
  if (!preview) return null;

  return (
    <View className="overflow-hidden rounded-lg bg-subtle">
      <Text className="px-2.5 pt-2 text-3xs text-foreground-subtle">Diff preview</Text>
      <ScrollView nestedScrollEnabled className="max-h-60" contentContainerStyle={{ padding: 10 }}>
        <ScrollView horizontal nestedScrollEnabled>
          <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
            {preview.lines.map((line, index) => (
              <Text
                // Preview positions are stable within one immutable patch.
                // oxlint-disable-next-line react/no-array-index-key
                key={index}
                className={cn(
                  line.kind === "addition" && "text-adaptive-emerald-600-400",
                  line.kind === "deletion" && "text-adaptive-rose-600-400",
                  line.kind === "hunk" && "text-foreground-subtle",
                )}
              >
                {index > 0 ? "\n" : ""}
                {line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}
                {line.text}
              </Text>
            ))}
          </Text>
        </ScrollView>
      </ScrollView>
      {preview.truncated ? (
        <Text className="px-2.5 pb-2 text-3xs text-foreground-subtle">Preview truncated</Text>
      ) : null}
    </View>
  );
}
