import { AuthProvider } from "@/lib/auth-context";

export default function UsageLayout({ children }: { children: React.ReactNode }) {
    return <AuthProvider>{children}</AuthProvider>;
}
