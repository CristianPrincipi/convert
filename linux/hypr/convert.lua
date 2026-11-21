-------------------------------------------
---- CONVERT: ruota di conversione ----
-------------------------------------------
-- Installato da ~/Progetti/convert/linux/install.sh (non modificare qui: si sovrascrive).
-- La ruota è una finestra trasparente che copre il monitor; disegna la ruota sotto il cursore.

hl.window_rule({
    name  = "convert-wheel",
    match = { title = "^convert-wheel$" },

    float        = true,
    pin          = true,
    size         = "monitor_w monitor_h",
    move         = "0 0",
    border_size  = 0,
    rounding     = 0,
    no_anim      = true,
    no_shadow    = true,
    no_blur      = true,
    no_dim       = true,
    stay_focused = true,
})
