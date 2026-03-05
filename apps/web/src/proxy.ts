import { NextRequest, NextResponse } from "next/server";

const INSTALL_REDIRECTS: Record<string, string> = {
  "/install.sh":
    "https://raw.githubusercontent.com/buildd-ai/buildd/main/apps/runner/install.sh",
  "/install.ps1":
    "https://raw.githubusercontent.com/buildd-ai/buildd/main/apps/runner/install.ps1",
};

export function proxy(request: NextRequest) {
  const dest = INSTALL_REDIRECTS[request.nextUrl.pathname];
  if (dest) {
    return NextResponse.redirect(dest, 302);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?\!_next/static|_next/image|favicon.ico|icon.png).*)"],
};
