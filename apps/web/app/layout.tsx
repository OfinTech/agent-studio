import type { Metadata } from "next";
import {
  ColorSchemeScript,
  MantineProvider,
  mantineHtmlProps,
} from "@mantine/core";
import "@mantine/core/styles.css";
import "@xyflow/react/dist/style.css";
export const metadata: Metadata = {
  title: "Agent Platform",
  description: "Turn incoming email into useful action.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript forceColorScheme="light" />
      </head>
      <body>
        <MantineProvider forceColorScheme="light">{children}</MantineProvider>
      </body>
    </html>
  );
}
