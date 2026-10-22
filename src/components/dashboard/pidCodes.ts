/** Siemens PID_Temp (S7-1200/1500) ErrorBits, Warning and State, in Finnish.
 * Source: TIA Portal V20 help "PID_Temp ErrorBits parameter" / "PID_Temp Warning tag".
 * ErrorBits stay latched until a rising edge at ErrorAck (or Reset); Error=1 means the error is still pending.
 * Warnings marked auto clear by themselves when the cause is gone, the others need ErrorAck/Reset. */
export type Code = { bit: number; title: string; cause: string; fix: string; auto?: boolean };

export const ERROR_BITS: Code[] = [
  { bit: 0x1, title: "Prosessiarvo (Input) mittausrajojen ulkopuolella", cause: "Input > Config.InputUpperLimit tai < InputLowerLimit: anturi irti/oikosulussa, väärä skaalaus tai liian tiukat rajat. ActivateRecoverMode=1: säädin pysyy auto-/käsitilassa.", fix: "Tarkista anturi ja Input-arvo sekä Config.InputUpper/LowerLimit. Kun arvo on taas rajoissa, kuittaa ErrorAck." },
  { bit: 0x2, title: "Virheellinen Input_PER-arvo", cause: "Analogiatulossa vika (johdinkatko, ylivuoto).", fix: "Tarkista analogiakortti ja johdotus. Säädin palaa automaatille kun vika poistuu; kuittaa ErrorAck." },
  { bit: 0x4, title: "Virhe hienovirityksessä: värähtelyä ei saatu ylläpidettyä", cause: "Lämmitys/jäähdytys-säätimellä PidOutputSum ei ole asetusarvossa oikean merkkinen.", fix: "Käytä virityssiirtymiä (PIDSelfTune.TIR.OutputOffsetHeat/Cool) ja toista viritys; kuittaa ErrorAck." },
  { bit: 0x8, title: "Virhe esivirityksen alussa", cause: "Prosessiarvo liian lähellä asetusarvoa tai sen yli.", fix: "Aloita hienoviritys tai muuta asetusarvoa ennen esiviritystä; kuittaa ErrorAck." },
  { bit: 0x10, title: "Asetusarvoa muutettiin virityksen aikana", cause: "Asetusarvo vaihteli enemmän kuin CancelTuningLevel sallii.", fix: "Älä muuta asetusarvoa virityksen aikana; toista viritys; kuittaa ErrorAck." },
  { bit: 0x20, title: "Esiviritys ei sallittu hienovirityksen aikana", cause: "Esiviritys käynnistettiin kesken hienovirityksen.", fix: "Odota hienoviritys loppuun tai keskeytä se; kuittaa ErrorAck." },
  { bit: 0x40, title: "Virhe esivirityksessä: jäähdytys ei laskenut prosessiarvoa", cause: "Jäähdytin ei toimi tai jäähdytyslähtö ei ole kytketty.", fix: "Tarkista jäähdytyslaite ja OutputCool-kytkentä; kuittaa ErrorAck." },
  { bit: 0x100, title: "Hienoviritys tuotti virheelliset parametrit", cause: "Viritysdatasta ei saatu kelvollisia parametreja.", fix: "Toista viritys vakaammissa olosuhteissa; kuittaa ErrorAck." },
  { bit: 0x200, title: "Virheellinen Input-arvo (lukumuoto)", cause: "Input ei ole kelvollinen REAL (NaN/Inf), esim. anturiarvon muunnosvirhe.", fix: "Tarkista Input-arvon lähde PLC-ohjelmassa. Korvaava lähtö käytössä kunnes vika poistuu; kuittaa ErrorAck." },
  { bit: 0x400, title: "Lähtöarvon laskenta epäonnistui", cause: "PID-parametrit virheelliset.", fix: "Tarkista Retain.CtrlParams (Gain, Ti, Td, Cycle); kuittaa ErrorAck." },
  { bit: 0x800, title: "Näytteenottoaikavirhe", cause: "PID_Tempiä ei kutsuta syklisen keskeytys-OB:n näytteenottoajassa (ehdollinen kutsu, kutsu OB1:ssä tai liian kuormitettu CPU).", fix: "Kutsu PID_Temp ehdoitta syklisessä keskeytys-OB:ssä (esim. OB30, 100 ms) ja ohjaa tilaa Mode-parametrilla. Valvonnan voi kytkeä pois CycleTime.EnMonitoring=FALSE. Kuittaa ErrorAck." },
  { bit: 0x1000, title: "Virheellinen Setpoint- tai SubstituteSetpoint-arvo", cause: "Asetusarvo ei ole kelvollinen REAL.", fix: "Tarkista asetusarvon lähde (OPC UA / PLC-ohjelma); kuittaa ErrorAck." },
  { bit: 0x10000, title: "Virheellinen ManualValue", cause: "Käsiarvo ei ole kelvollinen REAL; SubstituteOutput käytössä.", fix: "Anna kelvollinen käsiarvo; kuittaa ErrorAck." },
  { bit: 0x20000, title: "Virheellinen SubstituteOutput", cause: "Korvaava lähtöarvo ei ole kelvollinen REAL; käytetään lämmityksen alarajaa.", fix: "Korjaa SubstituteOutput; kuittaa ErrorAck." },
  { bit: 0x40000, title: "Virheellinen Disturbance", cause: "Häiriösuure ei ole kelvollinen REAL; asetetaan nollaksi.", fix: "Tarkista Disturbance-arvon lähde; kuittaa ErrorAck." },
  { bit: 0x200000, title: "Kaskadin master: slavet eivät automaatilla", cause: "Slave-säätimet estävät masterin virityksen.", fix: "Aseta slavet automaatille; kuittaa ErrorAck." },
  { bit: 0x400000, title: "Lämmityksen esiviritys ei sallittu jäähdytyksen ollessa päällä", cause: "Jäähdytys aktiivinen esivirityksen alussa.", fix: "Odota että jäähdytys loppuu; kuittaa ErrorAck." },
  { bit: 0x800000, title: "Prosessiarvon oltava lähellä asetusarvoa jäähdytyksen esiviritykseen", cause: "PV liian kaukana SP:stä.", fix: "Odota että PV on lähellä SP:tä; kuittaa ErrorAck." },
  { bit: 0x1000000, title: "Virityksen alku: Heat/Cool.EnableTuning puuttuu tai ristiriidassa", cause: "EnableTuning-bitit eivät vastaa konfiguraatiota.", fix: "Aseta Heat.EnableTuning / Cool.EnableTuning oikein; kuittaa ErrorAck." },
  { bit: 0x2000000, title: "Jäähdytyksen esiviritys vaatii onnistuneen lämmityksen esivirityksen", cause: "Lämmityksen esiviritystä ei ole tehty.", fix: "Tee ensin lämmityksen esiviritys; kuittaa ErrorAck." },
  { bit: 0x4000000, title: "Hienoviritys: Heat- ja Cool.EnableTuning ei saa olla yhtä aikaa", cause: "Molemmat EnableTuning-bitit päällä.", fix: "Valitse vain toinen; kuittaa ErrorAck." },
  { bit: 0x8000000, title: "PID-parametrien laskenta tuotti virheelliset arvot", cause: "Lähtö oli jo rajoittunut ennen esiviritystä; vanhat parametrit säilytetään.", fix: "Aloita viritys käsi- tai inaktiivitilasta tai tee SP-muutos samaan aikaan ModeActivaten kanssa; kuittaa ErrorAck." },
];

export const WARNING_BITS: Code[] = [
  { bit: 0x1, title: "Käännepistettä ei löytynyt esivirityksessä", cause: "Prosessi ei reagoinut odotetusti esiviritykseen.", fix: "Toista viritys tai käytä hienoviritystä.", auto: true },
  { bit: 0x4, title: "Asetusarvo rajoitettu", cause: "Setpoint on Config.SetpointUpper/LowerLimit -rajojen ulkopuolella.", fix: "Anna asetusarvo rajojen sisältä tai muuta rajoja.", auto: true },
  { bit: 0x8, title: "TIR-sääntö 3 käytössä", cause: "Valitulle laskentamenetelmälle ei ollut kaikkia prosessin ominaisuuksia.", fix: "Tarkista virityksen tulos; toista viritys tarvittaessa.", auto: true },
  { bit: 0x10, title: "Toimintatilan vaihto estetty", cause: "Reset = TRUE tai ManualEnable = TRUE.", fix: "Poista ManualEnable/Reset ennen tilan vaihtoa (Mode + ModeActivate)." },
  { bit: 0x20, title: "OB-sykli rajoittaa näytteenottoaikaa", cause: "Kutsuvan OB:n sykliaika on pidempi kuin PID-algoritmin tarvitsema näytteenottoaika.", fix: "Lyhennä syklisen keskeytys-OB:n aikaa (esim. 100 ms). Ei vaikuta turvallisuuteen; tieto säätölaadusta." },
  { bit: 0x40, title: "Prosessiarvo ylitti varoitusrajan", cause: "Input yli Config.InputUpperWarning tai alle InputLowerWarning.", fix: "Tarkista prosessi; poistuu itsestään kun PV palaa rajoihin.", auto: true },
  { bit: 0x80, title: "Virheellinen Mode-arvo", cause: "Mode-parametrissa tuntematon arvo; tilaa ei vaihdeta.", fix: "Käytä Mode 0/1/2/3/4/5." },
  { bit: 0x100, title: "Käsiarvo rajoitettu", cause: "ManualValue lähtöarvon rajojen ulkopuolella.", fix: "Anna käsiarvo lähtörajojen sisältä.", auto: true },
  { bit: 0x200, title: "Viritys­sääntöä ei tueta", cause: "TIR.TuneRuleHeat/Cool -arvo ei tuettu; parametreja ei lasketa.", fix: "Valitse tuettu viritys­sääntö." },
  { bit: 0x1000, title: "Korvaava lähtöarvo rajojen ulkopuolella", cause: "SubstituteOutput ei ole saavutettavissa lähtörajoissa.", fix: "Korjaa SubstituteOutput tai lähtörajat." },
  { bit: 0x4000, title: "Lähdön valintaa ei tueta", cause: "Valittu lämmitys/jäähdytys-lähtöyhdistelmä ei tuettu; käytetään vain OutputHeat tai OutputCool.", fix: "Tarkista Config.Output-valinnat." },
  { bit: 0x8000, title: "Virheellinen PIDSelfTune.SUT.AdaptDelayTime", cause: "Arvo ei kelpaa; käytetään oletusta 0.", fix: "Korjaa AdaptDelayTime." },
  { bit: 0x10000, title: "Virheellinen PIDSelfTune.SUT.CoolingMode", cause: "Arvo ei kelpaa; käytetään oletusta 0.", fix: "Korjaa CoolingMode." },
  { bit: 0x20000, title: "ActivateCooling ei tuettu masterina", cause: "Kaskadin master ei tue jäähdytystä; toimii lämmityssäätimenä.", fix: "Aseta Config.ActivateCooling = FALSE masterissa." },
  { bit: 0x40000, title: "Virheellinen vahvistus tai CoolFactor", cause: "Gain (lämmitys/jäähdytys) tai CoolFactor ei positiivinen. Automaatti jatkuu lähdöllä 0,0, I-osa pysäytetty.", fix: "Korjaa Retain.CtrlParams.Heat/Cool.Gain tai Config.CoolFactor positiiviseksi." },
];

export const STATES: { v: number; title: string; help: string }[] = [
  { v: 0, title: "Ei aktiivinen", help: "Säädin pois päältä, lähdöt 0. Aktivoidaan Mode=3 + ModeActivate (Auto-painike)." },
  { v: 1, title: "Esiviritys", help: "Automaattinen esiviritys käynnissä (askelkoe). Älä muuta asetusarvoa." },
  { v: 2, title: "Hienoviritys", help: "Hienoviritys käynnissä (värähtelykoe asetusarvon ympärillä)." },
  { v: 3, title: "Automaatti", help: "Normaali säätö: lähtö lasketaan PID-algoritmilla asetusarvon mukaan." },
  { v: 4, title: "Käsiajo", help: "Lähtö = ManualValue (−100…100 %). Palaa Auto-painikkeella." },
  { v: 5, title: "Korvaava lähtö (virhevalvonta)", help: "Virheen vuoksi lähtö = SubstituteOutput. Palaa automaatille kun vika poistuu (ActivateRecoverMode)." },
];

export const hex = (n: number | undefined) => (n === undefined || n === null ? "—" : `16#${(n >>> 0).toString(16).toUpperCase().padStart(4, "0")}`);
export const activeCodes = (table: Code[], value: number | undefined) => table.filter((c) => ((value ?? 0) & c.bit) !== 0);
export const unknownBits = (table: Code[], value: number | undefined) => ((value ?? 0) & ~table.reduce((a, c) => a | c.bit, 0)) >>> 0;
