# Planet atmospheres: heat vs. gravity

Standalone GitHub Pages build of the planet-atmosphere applet from [physics_demos](https://github.com/MartinAlvarezSergio/physics_demos).

Live: https://martinalvarezsergio.github.io/planet_atmosphere_playground/

A 2D gas of hard-disk particles: first in a sealed box, where temperature sets how fast the
particles move, then around a planet whose mass sets the escape speed. Tune temperature,
density and planet mass to see which atmospheres stay and which leak away. In planet mode,
compare solar-wind stripping with and without a magnetic field; use zoom to inspect
the wind-swept field bubble and particle paths.

```bash
npm install
npm run dev
npm run deploy   # build + publish gh-pages
```

The applet code is synchronized from `physics_demos/src/applets/planet_atmosphere`.
Publish source changes on `main`, then run `npm run deploy` to update GitHub Pages.
