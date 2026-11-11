# Respaldo y recuperación

## Qué respaldar
| Dato | Dónde | Frecuencia |
|---|---|---|
| Base de datos PostgreSQL | servidor de la API | diario (completo) + antes de cada despliegue o campaña masiva |
| Código | GitHub privado `twoitsolutions-dev/ubcbike` | cada commit |
| Secretos (`.env`) | gestor de contraseñas de TwoIT | al cambiar |
| Demo estática | se regenera desde el repo (`npm run build:static-demo`) | — |

## Comandos
```bash
# respaldo
pg_dump --format=custom --no-owner "$DATABASE_URL" > backups/ubc-$(date +%F-%H%M).dump
# restauración en una base vacía
createdb ubc_restore && pg_restore --no-owner -d ubc_restore backups/ubc-AAAA-MM-DD-HHMM.dump
```
- Guardar copias cifradas fuera del servidor (por ejemplo, almacenamiento de objetos con versión) y conservar 30 días.
- Probar una restauración al menos una vez al mes y antes de pasar a LIVE.
- El historial de precios (`price_history`) y la auditoría permiten reconstruir cambios aun sin restaurar todo.

## Antes de una operación masiva en LIVE
1. Respaldo manual.
2. Exportar CSV de la vista previa de la campaña.
3. Aplicar; si algo sale mal, **Restore original prices** (restauración segura) o restaurar desde `price_history`.
