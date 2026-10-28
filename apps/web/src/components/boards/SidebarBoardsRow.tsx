import { useLocation, useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { memo } from "react";

import { Badge } from "../ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { useBoardUnreadCount } from "./boardState";

export const SidebarBoardsRow = memo(function SidebarBoardsRow() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = useLocation({ select: (location) => location.pathname === "/boards" });
  const unreadCount = useBoardUnreadCount();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={active}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            void navigate({ to: "/boards" });
          }}
        >
          <MessagesSquareIcon />
          <span className="flex-1">Boards</span>
          {unreadCount > 0 ? <Badge variant="secondary">{unreadCount}</Badge> : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
});
