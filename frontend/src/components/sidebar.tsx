"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

const navItems = [
    { href: "/dashboard", label: "Dashboard", icon: "🏠" },
    { href: "/chat", label: "AI Chat", icon: "💬" },
    { href: "/files", label: "Files", icon: "📁" },
    { href: "/conversations", label: "Conversations", icon: "🗂️" },
    { href: "/api-keys", label: "API Keys", icon: "🔑" },
    { href: "/usage", label: "Usage", icon: "📊" },
    { href: "/memory", label: "Memory", icon: "🧠" },
    { href: "/settings", label: "Settings", icon: "⚙️" },
];

const adminItems = [
    { href: "/admin", label: "Admin Panel", icon: "👥" },
];

export default function Sidebar() {
    const pathname = usePathname();
    const { user, logout } = useAuth();
    const isAdmin = user?.role === "admin";

    return (
        <aside className="fixed left-0 top-0 h-screen w-64 bg-card border-r border-border flex flex-col z-50">
            {/* Logo */}
            <div className="p-6 border-b border-border">
                <h1 className="text-lg font-bold text-foreground">
                    🤖 AI Platform
                </h1>
                <p className="text-xs text-muted-foreground mt-1">Enterprise Edition</p>
            </div>

            {/* Navigation */}
            <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
                {navItems.map((item) => {
                    const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive
                                    ? "bg-primary/10 text-primary"
                                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                }`}
                        >
                            <span className="text-base">{item.icon}</span>
                            {item.label}
                        </Link>
                    );
                })}

                {isAdmin && (
                    <>
                        <div className="pt-4 pb-2">
                            <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                Admin
                            </p>
                        </div>
                        {adminItems.map((item) => {
                            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                            return (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive
                                            ? "bg-primary/10 text-primary"
                                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                        }`}
                                >
                                    <span className="text-base">{item.icon}</span>
                                    {item.label}
                                </Link>
                            );
                        })}
                    </>
                )}
            </nav>

            {/* User */}
            <div className="p-4 border-t border-border">
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary text-sm font-bold">
                        {user?.full_name?.[0] || user?.email?.[0] || "U"}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                            {user?.full_name || user?.email}
                        </p>
                        <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
                    </div>
                </div>
                <button
                    onClick={() => logout()}
                    className="w-full px-3 py-2 rounded-lg bg-muted hover:bg-destructive/10 hover:text-destructive text-muted-foreground text-sm font-medium transition-colors"
                >
                    Sign Out
                </button>
            </div>
        </aside>
    );
}
