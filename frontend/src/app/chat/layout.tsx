import { AuthProvider } from "@/lib/auth-context";
import { Suspense } from "react";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
    return (
        <AuthProvider>
            <Suspense>{children}</Suspense>
        </AuthProvider>
    );
}
