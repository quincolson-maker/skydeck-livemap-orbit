# SkyDeck Orbit
3D satellite-view companion to [SkyDeck Live Map](https://skydeck-livemap.onrender.com): a CesiumJS globe with a slow automated orbital camera over CONUS, made for a 75-inch TV.

- **Real sun**: Cesium SunLight driven by the real clock — day/night terminator, globe shading and atmosphere scattering follow the actual solar position. Night side shows NASA Black Marble city lights.
- **Imagery**: Esri World Imagery (day), NASA GIBS VIIRS Black Marble (night). No Cesium ion token used.
- **Live data**: METAR flight categories (aviationweather.gov, 5 min), GOES-East band-13 IR clouds (IEM, 10 min), NEXRAD radar toggle (IEM, 5 min).
- **Flight plans**: mirrored from the main Live Map (`PLAN_UPSTREAM`), so the same email inbox works; or POST `/api/inbound?key=…` here.
- **Spotlight** while a plan is loaded: orbit → departure → orbit → destination every `?cycle=` s (default 15).
- Keys: R/Enter radar, O return to orbit. `?orbit=900` orbit period (s), `?radar=1`, `?all=1`.
