"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
    LayoutGrid,
    Lock,
    ArrowRight,
    MailOpen,
    ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function RegisterPage() {
    const router = useRouter();
    const [token, setToken] = useState("");

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        const cleaned = token.trim();
        if (!cleaned) return;
        router.push(`/invite/${cleaned}`);
    }

    return (
        <div className="min-h-screen flex flex-col bg-background">
            {/* Background gradients */}
            <div className="fixed top-0 left-0 w-full h-full pointer-events-none -z-10 overflow-hidden">
                <div className="absolute top-[-10%] right-[-5%] w-[40%] h-[40%] rounded-full bg-primary/5 blur-[120px]" />
                <div className="absolute bottom-[-10%] left-[-5%] w-[30%] h-[30%] rounded-full bg-blue-400/5 blur-[100px]" />
            </div>

            <main className="flex-grow flex items-center justify-center p-4 sm:p-6 lg:p-8">
                <div className="w-full max-w-[520px] bg-card rounded-2xl shadow-xl overflow-hidden border border-border">
                    {/* Header */}
                    <div className="px-8 pt-10 pb-6 text-center">
                        <div className="flex justify-center mb-6">
                            <div className="flex items-center gap-2">
                                <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
                                    <LayoutGrid className="h-5 w-5" />
                                </div>
                                <h2 className="text-xl font-bold tracking-tight text-foreground">Enterprise AI Platform</h2>
                            </div>
                        </div>

                        <div className="inline-flex items-center justify-center gap-x-2 rounded-full bg-muted py-1.5 px-4 mb-6 border border-border">
                            <Lock className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">Invitation Only</span>
                        </div>

                        <h1 className="text-3xl font-extrabold text-foreground mb-2 tracking-tight">
                            Join Your Team
                        </h1>
                        <p className="text-muted-foreground text-base">
                            Enter your invitation token to create your account.
                        </p>
                    </div>

                    {/* Token entry form */}
                    <div className="px-8 pb-10">
                        {/* How it works */}
                        <div className="bg-muted/50 rounded-lg border border-border/50 p-5 mb-6 space-y-4">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">How it works</p>
                            <div className="flex items-start gap-3">
                                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                                    <MailOpen className="h-3.5 w-3.5 text-primary" />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-foreground">Receive an invite</p>
                                    <p className="text-xs text-muted-foreground">Your admin will send you a unique invite token.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                                    <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-foreground">Create your account</p>
                                    <p className="text-xs text-muted-foreground">Use the token to set up your credentials securely.</p>
                                </div>
                            </div>
                        </div>

                        <form onSubmit={handleSubmit} className="space-y-5">
                            <div>
                                <Label htmlFor="invite-token" className="text-sm font-semibold mb-1.5 block">Invite Token</Label>
                                <Input
                                    id="invite-token"
                                    type="text"
                                    value={token}
                                    onChange={(e) => setToken(e.target.value)}
                                    placeholder="e.g. inv_aBcDeFgHiJkLmNoPqRsT..."
                                    className="h-12 text-sm font-mono"
                                    autoFocus
                                />
                            </div>

                            <Button
                                type="submit"
                                className="w-full h-12 text-sm font-bold shadow-sm"
                                disabled={!token.trim()}
                            >
                                Continue
                                <ArrowRight className="ml-2 h-4 w-4" />
                            </Button>
                        </form>

                        {/* Footer */}
                        <div className="mt-8 text-center border-t border-border pt-6">
                            <p className="text-sm text-muted-foreground">
                                Already have an account?{" "}
                                <a className="font-bold text-primary hover:underline ml-1 transition-colors" href="/login">
                                    Sign In
                                </a>
                            </p>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
