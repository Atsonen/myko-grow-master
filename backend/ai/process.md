# Myko – prosessikuvaus (DeepSeek-konteksti)

## Tiivistelmä
- Kolme PID_Temp-säätöpiiriä (Siemens S7-1200, OB 100 ms): F1 kylmiö SP 8 °C (kompressori, minimijaksot 30 s), T1 terrario SP 24 °C (lämmitys), G_Air kasvamon ilma SP 30 °C (poistopuhallin PF-1 = "cool").
- Myko on SP:n auktoriteetti (sp-sync 15 s) ja syöttää PV:n suodatettuna OPC UA:n kautta (pvfeed). Ulkolämpö met.no.
- H/C: G_Air PID-lähtörajoilla (Heat.PidUpperLimit 0/100, Cool.PidLowerLimit 0/−100). F1/T1 vielä vanhoilla Ctrl-biteillä 8/9.
- ESP-virhekoodit −127…−119 eivät ole lämpötiloja. DS-anturien järjestys epävarma; DS4 jumittunut 8,89, dl27 −122, dl15 0 %RH.
- Saat vain ehdottaa. Et kirjoita PLC:lle. Kielletty: PID-instanssin suora kirjoitus, ON-kytkimen, SP:n tai H/C:n muutos ilman käyttäjän vahvistusta.

## Pisteet
| Piste | Kohde | Toimilaite | SP | PV (hälytys) | PV-syöttö (pvfeed) |
|---|---|---|---|---|---|
| F1 (ColdStorage1) | Kylmäsäilytystila 1 | kompressori (cool), min on/off 30 s | 8 °C | dl02 | SensorBlock_1.DStemp1, raja −10…30 |
| T1 (Terrario1) | Terrario 1 | lämmitys (heat) | 24 °C | dl00 | SensorBlock_1.DStemp2, raja 5…45 |
| G_Air (GardenAir) | Kasvamo, ilma | poistopuhallin PF-1 (cool), heat ei käytössä | 30 °C | dl03 | SensorBlock_2.DStemp2 (G Mid DS2), raja 0…50 |

Kompressorin (F1) lyhytjaksotusta vältetään: lähtö 100 % pitkään on normaalia vetovaiheessa, mutta yli 30 min saturaatio on poikkeama.

## Anturit ja lähteet
- SensorBlock_1 ja SensorBlock_2 (ESP, MQTT `Sensors/SensorBlock_N`, kentät DStemp1–4 ym.). Datalogger tallentaa ne tunnuksilla dlNN.
- SensorBlock_2: DStemp2 = dl03 G Mid DS2, DStemp3 = dl30 G Katto DS3, DStemp4 = dl31 G Poistoilma DS4 (tarkistettu 23.10.2026).
- DS-anturien fyysinen järjestys on epävarma (backlog): älä päättele sijaintia pelkästä numerosta.
- Tunnetut viat: DS4 jumissa 8,89 °C, dl27 −122 °C (Disabled), dl15 0 %RH.
- Dashboardin pisteet: dl02 (F1), dl00 (T1), dl03 (G_Air); lisäksi dl30/dl31 kasvamo, dl05 sisältää sterilointimittauksen (ei ulkolämpö).
- ESP-virhekoodit: −127 Missing, −126 ReadError, −125 Timeout, −124 OutOfRange, −123 NotReady, −122 Disabled, −121 Stale, −120 InvalidConfig, −119 AmbiguousId.
- 5 V anturireset (katkaisee SensorBlock 1+2) on suunniteltu, mutta PLC-puoli puuttuu; lukitus 5 min, max 3 / 24 h.

## PV-syöttö ja suodatus (pvfeed)
Hylätään: virhekoodit, ei-numeeriset, uskottavuusrajan ulkopuoliset, piikki |Δ| > 2,0 °C ellei 3 peräkkäistä näytettä vahvista uutta tasoa. Hylätty näyte ei mene PLC:lle (PLC pitää viimeisen arvon).
Hälytykset: SENSOR_VIKA (ei hyväksyttyä näytettä 30 s), INPUT_STALE (ei Input-kirjoitusta 60 s), ANTURIVIKA_ALASAJO (vika yli 5 min → Myko kytkee pisteen ON pois, ei automaattista paluuta).

## Asetusarvo (SP)
Myko (`alarm_point_controls`) on auktoriteetti. sp-sync 15 s: jos PLC:n Setpoint poikkeaa yli 0,05, Myko kirjoittaa oman arvonsa ja kirjaa "SP palautettu". G_Air kirjoitetaan 60 s välein (ei OPC UA -seurantaa).

## Lämmitys/jäähdytys (H/C)
- PID-rajatila (G_Air 24.10.2026 alkaen): Heat pois = Heat.PidUpperLimit 0, päällä 100; Cool pois = Cool.PidLowerLimit 0, päällä −100. Takaisinluku, tapahtumaloki, palautus 60 s välein. Ctrl bit8/9 vakiona 1.
- F1/T1: vielä vanhat Ctrl-sanan bitit 8 HEAT / 9 COOL (MQTT `Sensors/Mykovalvomo/Ctrl`). Nyt F1 COOL pois, T1 HEAT päällä.
- Rajamuutos voi aiheuttaa lähtöhypyn (PID_Temp V2 sovittaa integraalin). PLC:n uudelleenkäynnistys palauttaa rajat (Config ei retain).

## Turvatila ja alasajo
- Nykyinen: ANTURIVIKA_ALASAJO kytkee ON pois. Suunniteltu (DB_Myko, ei vielä PLC:ssä): watchdog (Hb_Counter, 5–120 s) ja Safe_Output (F1/T1 5 %, G_Air 30 %).

## Hälytykset ja WhatsApp
- Ctrl-sana per piste: bitit 0–6 hälytykset, 7 ON, 8 HEAT, 9 COOL, 10–14 SP, 15 WhatsApp pois.
- Rajat SP:n suhteen (`alarm_point_controls`): F1 WARN SP+1,0 30 min, HIGH SP+3 10 min, LOW SP−3 3 min, CRIT > 14 °C 3 min, FREEZE ≤ 0 °C heti. T1 WARN ±1,5 30 min, HIGH SP+3, LOW SP−3 10 min, CRIT > 30 °C, COLD < 15 °C. Lisäksi FLATLINE ja STALE (data yli 10 min vanha).
- WhatsApp lähtee hälytystarkistimelta (cold-alarm.timer, 1 min) ja DeepSeek-valvojan high-löydöksistä. Hälytykset voi mykistää enintään 24 h.
- PID-hälytykset: SENSOR_VIKA, INPUT_STALE, EI_AUTO, PID_VIKA, ERRORBITS, SATUROITUNUT (30 min). PID_Temp Warning 16#0020 on jatkuvasti päällä (tunnettu, ei raportoida).

## Normaalialueet ja vaararajat
| Piste | Normaali | Varoitus | Vaara |
|---|---|---|---|
| F1 | 7–9 °C | > 9 °C 30 min | > 14 °C, ≤ 0 °C (jäätyminen) |
| T1 | 22,5–25,5 °C | ±1,5 °C 30 min | > 30 °C, < 15 °C |
| G_Air | 28,5–31,5 °C | ±1,5 °C 30 min | > 33 °C pitkään |

## Ulkolämpötila
met.no Locationforecast (60.5309, 24.7966), haku 30 min välein, taulu `weather_metno`. Käytetään ML-dataan (`pid_training_log`, 1 rivi / PID / min).

## Sallitut ja kielletyt toimet
Sallittu (vain ehdotuksena, käyttäjä vahvistaa): PID-parametrimuutokset whitelistatuille jäsenille rajoissa (CtrlParamsBackUp + LoadBackUp, tilannekuva ensin), anturiresetin suositus, turvatila-arvon ehdotus, tarkistuspyyntö käyttäjälle.
Kielletty: suorat kirjoitukset PLC:lle tai PID-instanssiin, ON/SP/H/C-muutokset, viritys F1:llä/T1:llä ilman hyväksyntää, PLC-ohjelman muutokset, hälytysten mykistys, WhatsApp-viestit muuten kuin hälytysreitin kautta.
