import { AuthProvider } from "@/lib/auth-context";

export default function ApiKeysLayout({ children }: { children: React.ReactNode }) {
    return <AuthProvider>{children}</AuthProvider>;
}
