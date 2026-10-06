import { useMemo } from "react";
import { AppletHostAdapter } from "../core/host";
import { PlanetAtmosphereCanvas } from "../applets/planet_atmosphere/PlanetAtmosphereCanvas";

export function App(): JSX.Element {
  const host: AppletHostAdapter = useMemo(
    () => ({
      onClose: () => {},
      readReducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
    }),
    []
  );

  return (
    <div className="app-shell">
      <main>
        <section className="modal card">
          <PlanetAtmosphereCanvas host={host} />
        </section>
      </main>
    </div>
  );
}
