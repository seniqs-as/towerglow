# Bundled art

Three of the four `.glb` files in this directory are built from CC0 asset
packs by **[Kay Lousberg](https://kaylousberg.com)**. They are **not** covered
by the project's MIT licence: they are
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), which places
them in the public domain.

| File | Built from | Licence |
| --- | --- | --- |
| `spacebase.glb` | [KayKit : Space Base Bits](https://kaylousberg.itch.io/space-base-bits) | CC0 1.0 |
| `crew.glb` | [KayKit : Character Animations](https://kaylousberg.itch.io/kaykit-character-animations) | CC0 1.0 |
| `forest.glb` | [KayKit : Forest Nature Pack](https://kaylousberg.itch.io/kaykit-forest) | CC0 1.0 |

`villager.glb` is the odd one out: it is the project's own, made for it by
its author, and it goes under the project's licence like the rest of the
source. It is the figure you walk around in -- up the ramp and inside the
ship -- and it is built as a wardrobe on one skeleton: three heads, three
beards, three hairstyles, seven pieces of gear, six outfits, all skinned at
once. Loading it whole would put a figure on screen wearing every beard it
owns, so `assets/villager.ts` picks exactly one of each thing a person has
one of, and the rest stays in the file for whoever wants to dress you
differently.

The packing (one document, one material, one texture per pack; fifteen of the
161 animation clips, retargeted onto one skeleton) is Bot Crossing's, by
**[Jarren Rocks](https://jarren.rocks)**, MIT:
[github.com/Station-Sciences/bot-crossing](https://github.com/Station-Sciences/bot-crossing).

CC0 requires nothing of you. Crediting Kay costs nothing either.
