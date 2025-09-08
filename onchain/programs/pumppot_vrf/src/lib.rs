use anchor_lang::prelude::*;

declare_id!("PmpVRF1111111111111111111111111111111111111");

#[program]
pub mod pumppot_vrf {
    use super::*;

    pub fn start_draw(ctx: Context<StartDraw>, draw_id: String, token_mint: Pubkey, snapshot_hash: [u8; 32]) -> Result<()> {
        let state = &mut ctx.accounts.draw_state;
        state.authority = ctx.accounts.authority.key();
        state.draw_id = draw_id;
        state.token_mint = token_mint;
        state.snapshot_hash = snapshot_hash;
        state.status = 1; // pending
        // TODO: Request randomness from Pyth and store request id
        Ok(())
    }

    pub fn fulfill_randomness(ctx: Context<Fulfill>, randomness: [u8; 32], winner: Pubkey) -> Result<()> {
        let state = &mut ctx.accounts.draw_state;
        require!(state.status == 1, PumpError::InvalidState);
        state.randomness = Some(randomness);
        state.winner = Some(winner);
        state.status = 2; // fulfilled
        emit!(WinnerSelected {
            draw_id: state.draw_id.clone(),
            token_mint: state.token_mint,
            snapshot_hash: state.snapshot_hash,
            randomness,
            winner,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct StartDraw<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + DrawState::MAX_SIZE,
        seeds = [b"draw", authority.key().as_ref()],
        bump
    )]
    pub draw_state: Account<'info, DrawState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fulfill<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"draw", authority.key().as_ref()], bump)]
    pub draw_state: Account<'info, DrawState>,
}

#[account]
pub struct DrawState {
    pub authority: Pubkey,
    pub draw_id: String,
    pub token_mint: Pubkey,
    pub snapshot_hash: [u8; 32],
    pub randomness: Option<[u8; 32]>,
    pub winner: Option<Pubkey>,
    pub status: u8, // 0 new, 1 pending, 2 fulfilled
}

impl DrawState {
    pub const MAX_SIZE: usize = 32 + 4 + 128 + 32 + 32 + 1 + 33; // rough buffer
}

#[event]
pub struct WinnerSelected {
    pub draw_id: String,
    pub token_mint: Pubkey,
    pub snapshot_hash: [u8; 32],
    pub randomness: [u8; 32],
    pub winner: Pubkey,
}

#[error_code]
pub enum PumpError {
    #[msg("Invalid state for fulfillment")] InvalidState,
}


