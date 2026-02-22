"use client";

import { AuthProvider, useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Sidebar from "@/components/sidebar";

function DashboardContent() {
    const { user, isAuthenticated, isLoading } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, isLoading, router]);

    if (isLoading || !isAuthenticated) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background flex">
            <Sidebar />
            <main className="flex-1 ml-64 p-8">
                <div className="max-w-4xl">
                    <div className="mb-8">
                        <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
                        <p className="text-muted-foreground mt-1">
                            Welcome back, <span className="font-semibold text-foreground">{user?.full_name || user?.email}</span>
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                        <div className="bg-card border border-border rounded-xl p-6">
                            <p className="text-muted-foreground text-sm font-medium">Role</p>
                            <p className="text-foreground text-2xl font-bold mt-1 capitalize">{user?.role}</p>
                        </div>
                        <div className="bg-card border border-border rounded-xl p-6">
                            <p className="text-muted-foreground text-sm font-medium">Tenant ID</p>
                            <p className="text-foreground text-sm font-mono mt-1 truncate">{user?.tenant_id}</p>
                        </div>
                        <div className="bg-card border border-border rounded-xl p-6">
                            <p className="text-muted-foreground text-sm font-medium">User ID</p>
                            <p className="text-foreground text-sm font-mono mt-1 truncate">{user?.id}</p>
                        </div>
                    </div>

                    {/* Quick Links */}
                    <h2 className="text-lg font-semibold text-foreground mb-4">Quick Actions</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        <a href="/chat" className="bg-card border border-border rounded-xl p-6 hover:border-primary/50 hover:bg-primary/5 transition-colors group">
                            <span className="text-2xl">💬</span>
                            <h3 className="text-foreground font-semibold mt-2 group-hover:text-primary">AI Chat</h3>
                            <p className="text-muted-foreground text-sm mt-1">Start a conversation with AI</p>
                        </a>
                        <a href="/files" className="bg-card border border-border rounded-xl p-6 hover:border-primary/50 hover:bg-primary/5 transition-colors group">
                            <span className="text-2xl">📁</span>
                            <h3 className="text-foreground font-semibold mt-2 group-hover:text-primary">Upload Files</h3>
                            <p className="text-muted-foreground text-sm mt-1">Upload documents for RAG</p>
                        </a>
                        <a href="/api-keys" className="bg-card border border-border rounded-xl p-6 hover:border-primary/50 hover:bg-primary/5 transition-colors group">
                            <span className="text-2xl">🔑</span>
                            <h3 className="text-foreground font-semibold mt-2 group-hover:text-primary">API Keys</h3>
                            <p className="text-muted-foreground text-sm mt-1">Manage your API keys</p>
                        </a>
                        <a href="/usage" className="bg-card border border-border rounded-xl p-6 hover:border-primary/50 hover:bg-primary/5 transition-colors group">
                            <span className="text-2xl">📊</span>
                            <h3 className="text-foreground font-semibold mt-2 group-hover:text-primary">Usage</h3>
                            <p className="text-muted-foreground text-sm mt-1">Monitor LLM token usage</p>
                        </a>
                        <a href="/conversations" className="bg-card border border-border rounded-xl p-6 hover:border-primary/50 hover:bg-primary/5 transition-colors group">
                            <span className="text-2xl">🗂️</span>
                            <h3 className="text-foreground font-semibold mt-2 group-hover:text-primary">Conversations</h3>
                            <p className="text-muted-foreground text-sm mt-1">View chat history</p>
                        </a>
                        <a href="/settings" className="bg-card border border-border rounded-xl p-6 hover:border-primary/50 hover:bg-primary/5 transition-colors group">
                            <span className="text-2xl">⚙️</span>
                            <h3 className="text-foreground font-semibold mt-2 group-hover:text-primary">Settings</h3>
                            <p className="text-muted-foreground text-sm mt-1">Account settings</p>
                        </a>
                    </div>
                </div>
            </main>
        </div>
    );
}

export default function DashboardPage() {
    return (
        <AuthProvider>
            <DashboardContent />
        </AuthProvider>
    );
}
