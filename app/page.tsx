"use client";

import { useEffect } from "react";

export default function Home() {
  useEffect(() => {
    window.location.replace("/admin");
  }, []);

  return (
    <main>
      <p className="eyebrow">Attendance system</p>
      <h1>Opening admin console...</h1>
      <p><a href="/admin">Continue to the admin console</a></p>
    </main>
  );
}
