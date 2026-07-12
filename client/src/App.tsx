import { useEffect, useState } from "react";
import { Landing } from "./views/Landing";
import { Host } from "./views/Host";
import { Phone } from "./views/Phone";

/** Zero-dependency router: '/', '/host', '/p/:code'. */
function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function navigate(to: string): void {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  const path = usePath();
  const phone = path.match(/^\/p\/([A-Za-z]{4})$/);
  if (phone) return <Phone code={phone[1]!.toUpperCase()} />;
  if (path === "/host") return <Host />;
  return <Landing />;
}
