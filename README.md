# Lichess Clock Companion

Dieser Ordner enthält die Chrome-Erweiterung für das normale Lichess-Brett und einen separaten Web-Prototyp für akustische Uhrensignale.

## Chrome-Erweiterung für das normale Lichess-Brett

Die Erweiterung im Ordner `chrome-extension` liest die beiden sichtbaren Uhren direkt auf `lichess.org`. Sie braucht keinen API-Token und spielt oder verändert keine Züge.

1. Öffne `chrome://extensions` in Chrome und aktiviere **Entwicklermodus**.
2. Klicke auf **Entpackte Erweiterung laden** und wähle den Ordner `chrome-extension`.
3. Lade deinen Lichess-Tab neu und öffne eine Partie.
4. Klicke im eingeblendeten Feld auf **Signal aktivieren**. **Probehören** spielt tiefe/hohe Vergleichstöne und den Warnklick vor.

Standardmässig nimmt die Erweiterung die Uhr unten am Brett als deine. Falls nötig, kannst du Weiss oder Schwarz auswählen. Die Tonhöhe zeigt den Zeitunterschied: Hast du mehr Zeit, wird der Ton tiefer; hast du weniger, höher. Das Wiederholtempo zeigt deine eigene Restzeit und wird bei knapper Zeit schneller. Beim Unterschreiten von 10 Sekunden kommt einmalig ein Warnklick. Das Feld lässt sich minimieren.

Rated-Partien startest du über **Spiel erstellen**: Echtzeit auswählen, **1 Minute** und **0** oder **1 Sekunde Inkrement** einstellen und **Wertungsspiel** wählen. Das ergibt **1+0** beziehungsweise **1+1**; beide zählen bei Lichess als Bullet. Sobald die Partie im normalen Brett läuft, überwacht die Erweiterung die Uhren.

## Web-Prototyp lokal starten

Stelle diesen Ordner über localhost bereit und öffne die angezeigte Adresse. Zum Beispiel:

```sh
python3 -m http.server 8000
```

Öffne danach <http://localhost:8000> in einem aktuellen Browser. Über localhost kann der Browser die Lichess-API direkt ansprechen; beim direkten Öffnen von `index.html` kann der Browser API-Anfragen blockieren.

## Web-Prototyp verbinden

Erstelle unter <https://lichess.org/account/oauth/token/create> einen persönlichen API-Token mit dem Umfang `board:play` und füge ihn im Client ein. Teile den Token nicht. Die App hält ihn nur im Arbeitsspeicher und sendet Anfragen direkt von deinem Browser an `https://lichess.org`.

Der Client erkennt laufende Partien über die offizielle API und wartet sonst auf neue Partien. Über **Gegner suchen** kannst du eine öffentliche Rapid- oder Classical-Partie anfordern; standardmässig ist sie casual. Wenn sie startet, öffnet der Link **Partie im Lichess-Brett öffnen** das offizielle Brett. Der Client liest den Board-API-Spielestream mit den Uhrständen beider Spieler, spielt selbst aber keine Züge. Partien, die Lichess über diesen Stream nicht freigibt, kann er nicht überwachen.

Eine aktive Gegnersuche bleibt so lange bestehen, wie der Browser die Verbindung offen hält. Mit **Suche stoppen** wird sie beendet; wenn du die Seite schliesst, wird die Suche ebenfalls abgebrochen.

## Töne im Web-Prototyp

Jedes Signal besteht aus zwei Tönen: zuerst deine Uhr, dann die Uhr deines Gegners. Je mehr Restzeit eine Uhr hat, desto höher ist ihr Ton. Das Signal wiederholt sich schneller, wenn deine eigene Uhr knapp wird. Mit **Signal anhören** kannst du das Tonpaar probehören; die Lautstärke lässt sich mit dem Regler einstellen.
