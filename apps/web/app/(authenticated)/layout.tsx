import { redirect } from "next/navigation";
import { authenticated } from "../../lib/auth";
import { Platform } from "../../components/platform";
export const dynamic = "force-dynamic";
export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await authenticated())) redirect("/login");
  return <Platform>{children}</Platform>;
}
