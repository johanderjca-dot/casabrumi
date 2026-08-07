// ============================================================================
// migracion-cuentas.js — Casa Brumi, migración única del Plan de Cuentas
// ============================================================================
// Cómo correrlo:
//   1) Abre casabrumi (index.html) en el navegador y entra con tu cuenta.
//   2) Abre la consola de DevTools (Cmd+Opt+J en Chrome/Mac).
//   3) Pega TODO este archivo y presiona Enter.
//   4) Lee el resumen que imprime y confirma en el cuadro de diálogo.
//
// Usa las variables globales `db` y `firebase` que la propia página ya
// inicializó (no crea una conexión nueva). No necesita nada más.
//
// Es seguro correrlo más de una vez: cada paso revisa qué ya está hecho antes
// de escribir, así que una segunda corrida no duplica cuentas ni rompe nada.
// ============================================================================

(async () => {
    const TIENDA_ID = 'casa-brumi';

    const log  = (...a) => console.log('%c[migración]', 'color:#129A8F;font-weight:700', ...a);
    const warn = (...a) => console.warn('%c[migración]', 'color:#D07C1F;font-weight:700', ...a);
    const err  = (...a) => console.error('%c[migración]', 'color:#A03B3B;font-weight:700', ...a);

    if (typeof db === 'undefined' || typeof firebase === 'undefined') {
        err('No encuentro `db`/`firebase`. ¿Corriste esto en la consola de casabrumi con la página cargada?');
        return;
    }

    // ────────────────────────────────────────────────────────────────────
    // PASO 0 — RESPALDO. Si falla, aborta antes de tocar nada.
    // ────────────────────────────────────────────────────────────────────
    log('Paso 0 — descargando respaldo de cuentas_contables y asientos_contables...');
    let backupCuentas, backupAsientos;
    try {
        const [snapCuentas, snapAsientos] = await Promise.all([
            db.collection('cuentas_contables').get(),
            db.collection('asientos_contables').get(),
        ]);
        backupCuentas  = snapCuentas.docs.map(d => ({ id: d.id, ...d.data() }));
        backupAsientos = snapAsientos.docs.map(d => ({ id: d.id, ...d.data() }));

        // Los Timestamp de Firestore no son JSON directamente — los paso a ISO string.
        const firestoreReplacer = (key, value) => {
            if (value && typeof value === 'object' && typeof value.toDate === 'function') {
                return value.toDate().toISOString();
            }
            return value;
        };
        const backupJson = JSON.stringify({ cuentas_contables: backupCuentas, asientos_contables: backupAsientos }, firestoreReplacer, 2);
        const blob = new Blob([backupJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const a = document.createElement('a');
        a.href = url;
        a.download = `backup-contabilidad-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        log(`Respaldo descargado: ${backupCuentas.length} cuentas, ${backupAsientos.length} asientos. Revisa tu carpeta de Descargas.`);
    } catch (e) {
        err('El respaldo falló — ABORTANDO sin tocar nada. Detalle:', e);
        return;
    }

    // ────────────────────────────────────────────────────────────────────
    // Datos de la migración
    // ────────────────────────────────────────────────────────────────────
    const RENUMERAR = [
        { codigoViejo:'5100', codigoNuevo:'6110', nombreNuevo:'Publicidad de Producto', naturaleza:'directo' },
        { codigoViejo:'5200', codigoNuevo:'6120', nombreNuevo:'Envios Nacionales',       naturaleza:'directo' },
        { codigoViejo:'5300', codigoNuevo:'6310', nombreNuevo:'Gastos Bancarios',        naturaleza:'compartido' },
        { codigoViejo:'5400', codigoNuevo:'6210', nombreNuevo:'Gastos de Operaciones',   naturaleza:'compartido' },
        { codigoViejo:'5500', codigoNuevo:'6230', nombreNuevo:'Capacitaciones',          naturaleza:'compartido' },
    ];
    const CREAR_COSTO = [
        { codigo:'5100', nombre:'Costo de Mercancia Vendida', naturaleza:'directo' },
        { codigo:'5200', nombre:'Gastos de Importacion',      naturaleza:'directo' },
        { codigo:'5300', nombre:'Merma y Mercancia Danada',   naturaleza:'directo' },
    ];
    const CREAR_GASTO = [
        { codigo:'6115', nombre:'Publicidad de Marca',     naturaleza:'compartido' },
        { codigo:'6130', nombre:'Comisiones de Pasarela',  naturaleza:'directo' },
    ];
    const RENOMBRAR_1160 = { codigo:'1160', nombreViejo:'Mercacia En Transito', nombreNuevo:'Mercancía en Tránsito' };

    // ────────────────────────────────────────────────────────────────────
    // Helpers de lectura (todo scoped a TIENDA_ID)
    // ────────────────────────────────────────────────────────────────────
    const buscarCuenta = async (codigo, tipo) => {
        let q = db.collection('cuentas_contables').where('tiendaId','==',TIENDA_ID).where('codigo','==',codigo);
        if (tipo) q = q.where('tipo','==',tipo);
        const snap = await q.get();
        if (snap.size > 1) warn(`Hay ${snap.size} cuentas con código ${codigo}${tipo?` (tipo ${tipo})`:''} — uso la primera.`);
        return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
    };

    // ────────────────────────────────────────────────────────────────────
    // Plan (dry-run de lectura) — para el resumen y para saber qué falta
    // ────────────────────────────────────────────────────────────────────
    log('Calculando qué falta por hacer...');
    const planRenumerar = [];
    for (const r of RENUMERAR) {
        const vieja  = await buscarCuenta(r.codigoViejo, 'Gasto');
        const nueva  = await buscarCuenta(r.codigoNuevo, 'Gasto');
        if (vieja)      planRenumerar.push({ ...r, accion:'renumerar', cuenta:vieja });
        else if (nueva) planRenumerar.push({ ...r, accion:'ya migrada', cuenta:nueva });
        else            planRenumerar.push({ ...r, accion:'NO ENCONTRADA — revisar manualmente', cuenta:null });
    }
    const planCostoCrear = [];
    for (const c of CREAR_COSTO) {
        const existente = await buscarCuenta(c.codigo, 'Costo');
        planCostoCrear.push({ ...c, accion: existente ? 'ya existe' : 'crear' });
    }
    const planGastoCrear = [];
    for (const c of CREAR_GASTO) {
        const existente = await buscarCuenta(c.codigo, 'Gasto');
        planGastoCrear.push({ ...c, accion: existente ? 'ya existe' : 'crear' });
    }
    const cuenta1160 = await buscarCuenta(RENOMBRAR_1160.codigo);

    const nRenumerar   = planRenumerar.filter(p=>p.accion==='renumerar').length;
    const nCostoCrear  = planCostoCrear.filter(p=>p.accion==='crear').length;
    const nGastoCrear  = planGastoCrear.filter(p=>p.accion==='crear').length;
    const nRenombrar1160 = (cuenta1160 && cuenta1160.nombre !== RENOMBRAR_1160.nombreNuevo) ? 1 : 0;
    const snapAsientosTienda = await db.collection('asientos_contables').where('tiendaId','==',TIENDA_ID).get();
    const nAsientos = snapAsientosTienda.size;

    const resumen = [
        `Se descargó el respaldo (${backupCuentas.length} cuentas, ${backupAsientos.length} asientos).`,
        ``,
        `Esto es lo que va a hacer esta migración en la tienda "${TIENDA_ID}":`,
        `  • Renumerar ${nRenumerar} cuenta(s) de gasto (5100-5500 → 61xx/62xx/63xx)`,
        `  • Crear ${nCostoCrear} cuenta(s) tipo Costo (5100/5200/5300)`,
        `  • Crear ${nGastoCrear} cuenta(s) tipo Gasto nuevas (6115, 6130)`,
        `  • Marcar naturaleza='na' en cuentas Activo/Pasivo/Patrimonio/Ingreso`,
        `  • Corregir el nombre de la cuenta 1160 (${nRenombrar1160 ? 'pendiente' : 'ya está bien'})`,
        `  • Actualizar cuentaCodigo/cuentaNombre en las líneas de ${nAsientos} asiento(s)`,
        ``,
        planRenumerar.some(p=>p.accion.startsWith('NO ENCONTRADA')) ? '⚠ Hay cuentas a renumerar que no encontré ni como código viejo ni nuevo — revisa el log después.' : '',
        `¿Continuar?`,
    ].filter(Boolean).join('\n');

    log(resumen);
    if (!confirm(resumen)) {
        log('Cancelado por el usuario. No se escribió nada (además de lo ya descargado).');
        return;
    }

    // ────────────────────────────────────────────────────────────────────
    // PASO 1 — Renumerar cuentas de gasto
    // ────────────────────────────────────────────────────────────────────
    log('Paso 1 — renumerando cuentas de gasto...');
    let renumeradas = 0;
    for (const p of planRenumerar) {
        if (p.accion !== 'renumerar') { log(`  ${p.codigoViejo} → ${p.codigoNuevo}: ${p.accion}, salto.`); continue; }
        await db.collection('cuentas_contables').doc(p.cuenta.id).update({
            codigo: p.codigoNuevo, nombre: p.nombreNuevo, naturaleza: p.naturaleza,
        });
        renumeradas++;
        log(`  ${p.codigoViejo} → ${p.codigoNuevo} "${p.nombreNuevo}" (${p.naturaleza})`);
    }

    // ────────────────────────────────────────────────────────────────────
    // PASO 1b — Corrige el nombre de la cuenta 1160
    // ────────────────────────────────────────────────────────────────────
    if (cuenta1160 && cuenta1160.nombre !== RENOMBRAR_1160.nombreNuevo) {
        await db.collection('cuentas_contables').doc(cuenta1160.id).update({ nombre: RENOMBRAR_1160.nombreNuevo });
        log(`Paso 1b — cuenta 1160 renombrada a "${RENOMBRAR_1160.nombreNuevo}".`);
    } else if (cuenta1160) {
        log('Paso 1b — cuenta 1160 ya tenía el nombre correcto.');
    } else {
        warn('Paso 1b — no encontré la cuenta 1160, no se pudo renombrar.');
    }

    // ────────────────────────────────────────────────────────────────────
    // PASO 2 — Crea 3 cuentas tipo Costo
    // ────────────────────────────────────────────────────────────────────
    log('Paso 2 — creando cuentas tipo Costo...');
    let costoCreadas = 0;
    for (const p of planCostoCrear) {
        if (p.accion !== 'crear') { log(`  ${p.codigo} "${p.nombre}": ya existe, salto.`); continue; }
        await db.collection('cuentas_contables').add({
            codigo: p.codigo, nombre: p.nombre, tipo: 'Costo', moneda: 'DOP',
            naturaleza: p.naturaleza, operativo: null, activa: true, tiendaId: TIENDA_ID,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        costoCreadas++;
        log(`  creada ${p.codigo} "${p.nombre}" (${p.naturaleza})`);
    }

    // ────────────────────────────────────────────────────────────────────
    // PASO 3 — Crea 2 cuentas tipo Gasto
    // ────────────────────────────────────────────────────────────────────
    log('Paso 3 — creando cuentas tipo Gasto nuevas...');
    let gastoCreadas = 0;
    for (const p of planGastoCrear) {
        if (p.accion !== 'crear') { log(`  ${p.codigo} "${p.nombre}": ya existe, salto.`); continue; }
        await db.collection('cuentas_contables').add({
            codigo: p.codigo, nombre: p.nombre, tipo: 'Gasto', moneda: 'DOP',
            naturaleza: p.naturaleza, operativo: true, activa: true, tiendaId: TIENDA_ID,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        gastoCreadas++;
        log(`  creada ${p.codigo} "${p.nombre}" (${p.naturaleza})`);
    }

    // ────────────────────────────────────────────────────────────────────
    // PASO 4 — naturaleza='na' en Activo, Pasivo, Patrimonio, Ingreso
    // ────────────────────────────────────────────────────────────────────
    log('Paso 4 — marcando naturaleza="na" en Activo/Pasivo/Patrimonio/Ingreso...');
    let marcadasNa = 0;
    for (const tipo of ['Activo','Pasivo','Patrimonio','Ingreso']) {
        const snap = await db.collection('cuentas_contables').where('tiendaId','==',TIENDA_ID).where('tipo','==',tipo).get();
        for (const doc of snap.docs) {
            if (doc.data().naturaleza === 'na') continue;
            await doc.ref.update({ naturaleza: 'na' });
            marcadasNa++;
        }
    }
    log(`  ${marcadasNa} cuenta(s) marcadas.`);

    // ────────────────────────────────────────────────────────────────────
    // PASO 5 — CRÍTICO: refresca cuentaCodigo/cuentaNombre en las líneas
    // de todos los asientos, en batches de 400.
    // ────────────────────────────────────────────────────────────────────
    log('Paso 5 — refrescando cuentaCodigo/cuentaNombre en las líneas de los asientos...');
    const snapCuentasFinal = await db.collection('cuentas_contables').where('tiendaId','==',TIENDA_ID).get();
    const cuentasById = {};
    snapCuentasFinal.docs.forEach(d => { cuentasById[d.id] = d.data(); });

    const snapAsientosFinal = await db.collection('asientos_contables').where('tiendaId','==',TIENDA_ID).get();
    let asientosActualizados = 0;
    let lineasTocadas = 0;
    const lineasSinProducto = []; // advertencias para el reporte final

    const BATCH_SIZE = 400;
    let batch = db.batch();
    let enBatch = 0;

    for (const doc of snapAsientosFinal.docs) {
        const asiento = doc.data();
        let cambio = false;
        const lineasNuevas = (asiento.lineas || []).map((l, i) => {
            const cuenta = cuentasById[l.cuentaId];
            if (!cuenta) {
                warn(`  Asiento ${doc.id} (${asiento.fecha}), línea ${i}: cuentaId ${l.cuentaId} ya no existe — dejo la línea igual.`);
                return l;
            }
            if (cuenta.naturaleza === 'directo' && !l.productoId) {
                lineasSinProducto.push({ asientoId: doc.id, fecha: asiento.fecha, linea: i, cuenta: `${cuenta.codigo} — ${cuenta.nombre}` });
            }
            if (l.cuentaCodigo === cuenta.codigo && l.cuentaNombre === cuenta.nombre) return l;
            cambio = true;
            lineasTocadas++;
            return { ...l, cuentaCodigo: cuenta.codigo, cuentaNombre: cuenta.nombre };
        });
        if (!cambio) continue;

        batch.update(doc.ref, { lineas: lineasNuevas });
        enBatch++;
        asientosActualizados++;

        if (enBatch >= BATCH_SIZE) {
            await batch.commit();
            log(`  ...${asientosActualizados} asientos actualizados hasta ahora`);
            batch = db.batch();
            enBatch = 0;
        }
    }
    if (enBatch > 0) await batch.commit();

    // Recorre TODOS los asientos (no solo los que cambiaron de nombre) para el
    // reporte de líneas "directo" sin producto — incluye los que ya estaban al día.
    for (const doc of snapAsientosFinal.docs) {
        const asiento = doc.data();
        (asiento.lineas || []).forEach((l, i) => {
            const cuenta = cuentasById[l.cuentaId];
            if (!cuenta || cuenta.naturaleza !== 'directo' || l.productoId) return;
            if (lineasSinProducto.some(w => w.asientoId === doc.id && w.linea === i)) return; // ya la agregamos arriba
            lineasSinProducto.push({ asientoId: doc.id, fecha: asiento.fecha, linea: i, cuenta: `${cuenta.codigo} — ${cuenta.nombre}` });
        });
    }

    // ────────────────────────────────────────────────────────────────────
    // PASO 6 — Reporte final
    // ────────────────────────────────────────────────────────────────────
    log('═══════════════════════════════════════════');
    log('REPORTE FINAL');
    log('═══════════════════════════════════════════');
    log(`Cuentas renumeradas:        ${renumeradas}`);
    log(`Cuentas Costo creadas:      ${costoCreadas}`);
    log(`Cuentas Gasto creadas:      ${gastoCreadas}`);
    log(`Cuentas marcadas naturaleza='na': ${marcadasNa}`);
    log(`Asientos actualizados:      ${asientosActualizados} de ${snapAsientosFinal.size}`);
    log(`Líneas con código/nombre corregido: ${lineasTocadas}`);
    if (lineasSinProducto.length === 0) {
        log('Sin advertencias — todas las líneas de cuentas "directo" tienen producto asignado.');
    } else {
        warn(`${lineasSinProducto.length} línea(s) de cuenta "directo" SIN producto asignado (corrígelas en Libro Diario → ✎ Editar):`);
        console.table(lineasSinProducto);
    }
    log('Migración terminada.');
})();
