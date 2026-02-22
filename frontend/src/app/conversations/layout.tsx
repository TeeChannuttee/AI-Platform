import { AuthProvider } from "@/lib/auth-context";

export default function ConversationsLayout({ children }: { children: React.ReactNode }) {
    return <AuthProvider>{children}</AuthProvider>;
}
