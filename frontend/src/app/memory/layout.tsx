import { AuthProvider } from "@/lib/auth-context";

export default function MemoryLayout({ children }: { children: React.ReactNode }) {
    return <AuthProvider>{children}</AuthProvider>;
}
