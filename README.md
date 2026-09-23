# OpenTopoMap Vector – saját beállítások

Egy Violentmonkey userscript az OpenTopoMap vektoros változatához.

A script célja, hogy néhány olyan beállítást tegyen könnyen módosíthatóvá, amely az eredeti OpenTopoMap Vector felületén nem állítható közvetlenül.

## Funkciók

A script jelenleg az alábbi lehetőségeket adja hozzá:

- a térképi feliratok méretének módosítása
- a szintvonalak vastagságának módosítása
- opcionális kiegészítő domborzati nevek megjelenítése OpenStreetMap-adatokból
- a kiegészítő domborzati nevek kézi frissítése

A kezelőpanel a térkép jobb felső részén jelenik meg.

## Feliratméret

A térképi feliratok mérete az alábbi értékek közül választható:

- 100%
- 125%
- 150%
- 175%
- 200%

A kiválasztott értéket a script elmenti, így az a következő megnyitáskor is megmarad.

## Szintvonal-vastagság

A vektoros OpenTopoMap szintvonalainak vastagsága szintén az alábbi értékek közül állítható:

- 100%
- 125%
- 150%
- 175%
- 200%

Ez a beállítás is megmarad a következő használatig.

## Domborzati nevek

A script opcionálisan további domborzati neveket tud megjeleníteni az OpenStreetMap adataiból.

Jelenleg az alábbi objektumokat kezeli:

- csúcsok (`natural=peak`)
- nyergek (`natural=saddle`)

A kiegészítő nevek csak 12-es vagy nagyobb zoomszinten jelennek meg.

### BE

Bekapcsolja a kiegészítő OSM-nevek használatát.

A script ekkor:

1. létrehozza a szükséges saját térképréteget;
2. ellenőrzi, van-e használható gyorsítótárazott adat;
3. szükség esetén lekérdezi az aktuálisan látható terület csúcs- és nyeregadatait;
4. megjeleníti azokat a térképen.

### KI

Kikapcsolja a kiegészítő domborzati neveket.

Kikapcsolt állapotban:

- nem indul Overpass-lekérdezés;
- nem töltődnek be a gyorsítótárazott OSM-nevek a térképre;
- a script eltávolítja a saját névrétegét;
- egy esetleg futó lekérdezést is megszakít.

A domborzati nevek minden új oldalbetöltéskor alapértelmezetten **kikapcsolt állapotban** indulnak.

### Frissítés

A `Frissítés` gomb csak akkor aktív, amikor a domborzati nevek be vannak kapcsolva.

Segítségével kézzel újra lekérdezhetők az OSM-adatok az aktuálisan látható területre.

Ez akkor lehet hasznos, ha:

- az Overpass-szerver korábban nem válaszolt;
- a térképet nagyobb távolságra elmozdítottuk;
- friss OSM-adatot szeretnénk lekérni.

## Adatforrások

A script az OpenTopoMap Vector térképet módosítja, és a kiegészítő domborzati nevekhez az OpenStreetMap adatait használja.

Az OSM-adatok lekérdezése Overpass API-n keresztül történik.

A script több Overpass-szervert is ismer, így ha az egyik éppen nem elérhető, megpróbálhat egy másikat.

## Gyorsítótár

A script a sikeresen lekért OSM-neveket helyileg gyorsítótárazza.

A gyorsítótár célja, hogy ugyanarra a területre ne kelljen feleslegesen újra lekérni az adatokat.

A gyorsítótárban tárolt adatok legfeljebb 6 órán át használhatók.

Fontos: a gyorsítótár tartalma csak akkor kerül vissza a térképre, ha a felhasználó külön bekapcsolja a domborzati neveket.

## Telepítés

### 1. Violentmonkey telepítése

Telepíts egy userscript-kezelőt, például a Violentmonkey bővítményt.

### 2. A script telepítése

Nyisd meg a `.user.js` fájlt Raw nézetben a GitHubon.

Ha a userscript-kezelő megfelelően működik, fel kell ajánlania a script telepítését.

### 3. OpenTopoMap megnyitása

A script ezen az oldalon működik:

`https://www.opentopomap.org/vector/`

Az oldal újratöltése után meg kell jelennie a saját kezelőpanelnek.

## Használat

A jobb felső sarokban megjelenő panelen három rész látható:

- Feliratméret
- Szintvonal
- Domborzati nevek

A domborzati neveknél három gomb található:

- `BE`
- `KI`
- `Frissítés`

A script állapotsora jelzi többek között:

- hogy a térkép sikeresen elérhető-e;
- hány feliratréteget kezel;
- hogy a domborzati nevek ki vannak-e kapcsolva;
- folyamatban van-e lekérdezés;
- hány kiegészítő név töltődött be;
- történt-e lekérdezési hiba.

## Fontos megjegyzés

A script csak a vektoros OpenTopoMap változathoz készült.

A raszteres OpenTopoMap feliratai és szintvonalai egyetlen képcsempébe vannak beégetve, ezért azok külön-külön nem módosíthatók ugyanilyen módon.

A vektoros OpenTopoMap domborzati szintvonalai nem feltétlenül egyeznek pontosan a klasszikus raszteres OpenTopoMap szintvonalaival, mert a két változat eltérő domborzatmodellből és eltérő feldolgozással készülhet.

## Verzió

Jelenlegi verzió:

`2.1`

## Fájl

Javasolt fájlnév:

`opentopomap-vector-tools.user.js`

## Licenc

A scripthez érdemes külön licencet választani.

Egyszerű, nyílt felhasználásra például megfelelő lehet az MIT License.

Az OpenTopoMap és az OpenStreetMap saját licencei és felhasználási feltételei ettől függetlenek.
