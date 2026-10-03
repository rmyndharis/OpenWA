import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { XENWA_PERMISSIONS } from '../xenwa-permissions';

export class XenwaSsoDto {
  @IsString()
  @MinLength(20)
  @MaxLength(8192)
  token!: string;
}

export class XenwaHandoffDto {
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  code!: string;
}

export class XenwaCreateAccountDto {
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  name!: string;
}

export class XenwaGrantDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(XENWA_PERMISSIONS.length)
  @IsIn(XENWA_PERMISSIONS, { each: true })
  permissions?: string[];
}

export class XenwaUpdateGrantDto {
  @IsArray()
  @ArrayMaxSize(XENWA_PERMISSIONS.length)
  @IsIn(XENWA_PERMISSIONS, { each: true })
  permissions!: string[];
}

export class XenwaSetOwnerDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
