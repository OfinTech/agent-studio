"use client";
import {
  Anchor,
  AppShell,
  Breadcrumbs,
  Burger,
  Button,
  Group,
  Menu,
  NavLink,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  Activity,
  Inbox,
  KeyRound,
  LayoutGrid,
  LogOut,
  Settings,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import type { PlatformController } from "./use-platform";
const navigation = [
  { id: "workflows", label: "Workflows", icon: LayoutGrid },
  { id: "runs", label: "Run history", icon: Activity },
  { id: "tools", label: "MCP tools", icon: Wrench },
  { id: "credentials", label: "Credentials", icon: KeyRound },
  { id: "mock-receipts", label: "Mock receipts", icon: Inbox },
  { id: "settings", label: "Settings", icon: Settings },
] as const;
export function ApplicationShell({
  controller: c,
  children,
}: {
  controller: PlatformController;
  children: React.ReactNode;
}) {
  const [opened, { toggle, close }] = useDisclosure();
  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 240, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap" flex={1} miw={0}>
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              aria-label="Toggle navigation"
              aria-controls="workspace-navigation"
              aria-expanded={opened}
            />
            <Breadcrumbs flex={1} miw={0}>
              {c.workflowId ? (
                <Anchor
                  component={Link}
                  href="/workflows"
                  onNavigate={c.onNavigate("/workflows")}
                >
                  Workflows
                </Anchor>
              ) : (
                <Text>{navigation.find((n) => n.id === c.view)?.label}</Text>
              )}
              {Boolean(c.workflowId) && (
                <Text truncate>{c.draft?.name ?? "Workflow not found"}</Text>
              )}
            </Breadcrumbs>
          </Group>
          <Menu>
            <Menu.Target>
              <Button variant="default" aria-label="Account menu">
                Account
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{c.data?.adminEmail ?? "Administrator"}</Menu.Label>
              <Menu.Item
                leftSection={<LogOut size={16} />}
                onClick={() => c.navigate("/login")}
              >
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md" id="workspace-navigation">
        <Stack gap="md">
          <Text>Agent Platform</Text>
          {navigation.map((item) => (
            <NavLink
              component={Link}
              href={`/${item.id}`}
              key={item.id}
              label={item.label}
              active={c.view === item.id}
              leftSection={<item.icon size={18} />}
              onNavigate={(event) => {
                c.onNavigate(`/${item.id}`)(event);
                close();
              }}
            />
          ))}
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main h={c.workflowId ? "100dvh" : undefined}>
        {children}
      </AppShell.Main>
    </AppShell>
  );
}
