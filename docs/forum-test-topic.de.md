# Test Adapter fairland V0.2.16

Entwurf für den Bereich „tester“ auf https://forum.iobroker.net.
Beim Veröffentlichen bitte in die dort angebotene Standardvorlage übernehmen.

## Adapter und Version

- Adapter: `ioBroker.fairland`
- Version: `0.2.16`
- Stand dieses Testaufrufs: 12.09.2026
- Repository und Dokumentation: https://github.com/dude2k/ioBroker.fairland
- Fehler melden: https://github.com/dude2k/ioBroker.fairland/issues

## Was macht der Adapter?

Der Adapter bindet Pool-Wärmepumpen und Poolpumpen über die Fairland-iGarden-Cloud
in ioBroker ein. Dazu gehören Fairland-Geräte sowie entsprechende OEM-Geräte,
zum Beispiel von Madimack. Geräte mit der SmartPool-App werden nicht unterstützt.

Je nach Gerät stehen Temperaturen, Betriebszustände, Leistungswerte und
Einstellungen für Temperatur, Modus oder Pumpendrehzahl zur Verfügung.

## Installation und Voraussetzungen

Der Adapter ist im ioBroker-Repository **latest** verfügbar. Dieses Repository
in ioBroker Admin auswählen und anschließend `fairland` installieren.

- Node.js ab Version 22
- js-controller ab Version 6.0.11
- Admin ab Version 7.8.23
- Ein iGarden-Konto mit einem unterstützten Gerät

In den Instanzeinstellungen iGarden-Zugangsdaten hinterlegen und bei Bedarf
Login-Land, Abfrageintervall und Courtyard auswählen.

## Bitte testen

- Installation und Start des Adapters
- Anmeldung, automatische Serverauswahl und Geräteerkennung
- Plausibilität von Messwerten, Einheiten und Betriebszuständen
- Übernahme von Änderungen an Solltemperatur, Modus und Pumpendrehzahl
- Wiederanlauf nach Adapter-Neustart und Verhalten bei Verbindungsunterbrechung

Bitte bei Rückmeldungen Gerätemodell, Adapter-Version, Node.js-Version,
js-controller-Version und eine Beschreibung des Verhaltens angeben.
Vor dem Teilen von Logs Zugangsdaten, E-Mail-Adressen und Tokens entfernen.

## Bekannte Einschränkung

Die iGarden-Cloud erlaubt üblicherweise nur eine aktive Sitzung je Konto.
Die App und der Adapter können sich daher gegenseitig abmelden. Ein zweites
iGarden-Konto anlegen, das Gerät an dieses Konto freigeben und dieses Konto
für den Adapter verwenden.

## Nach dem Veröffentlichen

Den Link zum veröffentlichten Thema in Issue #16 hinterlegen. Erst danach ist
die dort verlangte Einrichtung eines Test-Themas erfüllt:
https://github.com/dude2k/ioBroker.fairland/issues/16
